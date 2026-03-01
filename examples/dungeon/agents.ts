// ─── LLM Dungeon Roguelike: Agent Definitions ───────────────────────────────
//
// Two opposing agents:
//   DM Agent  → generates the dungeon, controls entities, resolves actions
//   Hero Agent → observes the world, decides what to do each turn
//
// Key insight: the DM doesn't follow hardcoded rules. It uses LLM reasoning
// to determine what happens, replacing traditional simulation entirely.

import type { Message, LLMProvider } from '../../src/index.js';
import type {
  GameState, GameConfig, Entity,
  DungeonGen, HeroAction, DMResolution,
} from './types.js';

// ─── JSON Parsing ────────────────────────────────────────────────────────────

function parseJSON<T>(text: string, fallback: T): T {
  // Try direct parse
  try { return JSON.parse(text); } catch {}
  // Try extracting from markdown code block
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1]); } catch {}
  }
  // Try finding first { to last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  console.error('[WARN] Failed to parse LLM JSON, using fallback');
  return fallback;
}

// ─── State Serialization ─────────────────────────────────────────────────────

function serializeMapWithEntities(state: GameState): string[] {
  const display = state.map.map(row => [...row]);
  for (const e of state.entities) {
    if (e.hp > 0 && e.y >= 0 && e.y < state.height && e.x >= 0 && e.x < state.width) {
      display[e.y][e.x] = e.symbol;
    }
  }
  display[state.hero.y][state.hero.x] = '@';
  return display.map(row => row.join(''));
}

function serializeState(state: GameState): string {
  const mapDisplay = serializeMapWithEntities(state);
  const entities = state.entities
    .filter(e => e.hp > 0)
    .map(e => `  ${e.id} "${e.name}" ${e.symbol} pos=(${e.x},${e.y}) HP:${e.hp}/${e.max_hp} ATK:${e.attack} ${e.hostile ? 'hostile' : 'neutral'}`)
    .join('\n');
  const items = state.hero.items.length > 0 ? state.hero.items.join(', ') : 'none';
  const recent = state.log.slice(-5).map(l => `  - ${l}`).join('\n');

  return `TURN ${state.turn} | FLOOR ${state.floor}

MAP (@ = hero, uppercase letters = entities):
${mapDisplay.join('\n')}

HERO: pos=(${state.hero.x},${state.hero.y}) HP:${state.hero.hp}/${state.hero.max_hp} ATK:${state.hero.attack} DEF:${state.hero.defense} LVL:${state.hero.level} Items:[${items}]

ENTITIES:
${entities || '  (none)'}

RECENT EVENTS:
${recent || '  (none)'}`;
}

// ─── DM Agent ────────────────────────────────────────────────────────────────

const DM_GEN_PROMPT = (w: number, h: number, floor: number) => `You are the Dungeon Master AI for a minimalist roguelike game.
You generate and control the dungeon environment. You ARE the world.

TASK: Generate floor ${floor} of the dungeon.

MAP RULES:
- Size: EXACTLY ${w} columns x ${h} rows. Every row must be exactly ${w} characters.
- The entire border (first/last row, first/last column) must be walls (#).
- Tiles: # (wall)  . (floor)  + (door)  < (entrance)  > (exit)
- The map must be connected — the hero can walk from < to >.
- Create interesting rooms connected by corridors with doors.
- Floor ${floor}: ${floor === 1 ? 'easy layout, 2-3 small rooms' : floor <= 3 ? 'moderate complexity, 3-4 rooms with corridors' : 'complex layout, many rooms, traps, dead ends'}.

ENTITY RULES:
- Place ${Math.min(2 + floor, 6)} monsters appropriate for floor ${floor}.
- Each entity: {"id": "unique_id", "name": "...", "symbol": "X", "x": N, "y": N, "hp": N, "max_hp": N, "attack": N, "hostile": true}
- Symbols: G=goblin S=skeleton B=bat R=rat O=ogre D=demon W=wolf K=kobold
- Entities must be placed on floor tiles (.), NOT on walls (#) or entrance/exit.
- Floor ${floor} difficulty: ${floor === 1 ? 'weak monsters (rats, bats, goblins) HP:4-8 ATK:1-3' : floor <= 3 ? 'moderate (skeletons, wolves, kobolds) HP:8-15 ATK:3-5' : 'strong (ogres, demons) HP:15-25 ATK:5-8'}.

HERO START: Place hero_start on the entrance (<) tile position.

Respond with ONLY valid JSON (no markdown, no explanation):
{"map":["row1","row2",...],"entities":[...],"hero_start":[x,y],"narration":"atmospheric description"}`;

const DM_RESOLVE_PROMPT = `You are the Dungeon Master AI. You control ALL non-player entities and determine consequences of actions.

RESOLUTION RULES:
1. Resolve the hero's action — determine success/failure and consequences.
2. Move ALL hostile entities that are alive. They pursue the hero intelligently but not omnisciently.
   - Entities can only move to floor tiles (. + < >), never through walls (#).
   - Entities move at most 1 tile per turn (horizontally or vertically, not diagonally).
   - Entities attack the hero if they are adjacent (within 1 tile, cardinal directions only).
3. Combat: hero_damage = total damage dealt TO the hero this turn (from all sources).
   entity_damage = list of damage dealt to each entity this turn.
4. If an entity reaches 0 HP, add its id to killed_entities.
5. If the hero steps onto the exit tile (>), set victory=true, game_over=true.
6. If hero HP would drop to 0 or below, set game_over=true, victory=false.
7. Be challenging but fair — the hero should have roughly 50% win rate.
8. Entity new positions must be valid floor tiles in the map.
9. Do NOT move the hero — only move non-player entities.

Respond with ONLY valid JSON (no markdown):
{"narration":"what happens","hero_damage":0,"hero_heal":0,"items_gained":[],"entity_moves":[{"id":"...","x":0,"y":0}],"entity_damage":[{"id":"...","damage":0}],"killed_entities":[],"map_changes":[],"new_entities":[],"game_over":false,"victory":false,"game_over_reason":""}`;

export function createDM(provider: LLMProvider, config: GameConfig) {
  let history: Message[] = [];

  async function generateDungeon(floor: number): Promise<{ gen: DungeonGen; tokens: number }> {
    const messages: Message[] = [
      { role: 'system', content: DM_GEN_PROMPT(config.mapWidth, config.mapHeight, floor) },
      { role: 'user', content: `Generate floor ${floor}. Remember: exactly ${config.mapWidth} columns x ${config.mapHeight} rows.` },
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await provider.chat(messages, undefined, config.dmModel);
      const respContent = resp.content ?? '';
      const respTokens = resp.usage?.total_tokens ?? 0;
      const gen = parseJSON<DungeonGen>(respContent, null as any);

      if (gen && gen.map && gen.map.length === config.mapHeight) {
        // Fix row widths if needed
        gen.map = gen.map.map(row => {
          if (row.length < config.mapWidth) return row + '#'.repeat(config.mapWidth - row.length);
          if (row.length > config.mapWidth) return row.slice(0, config.mapWidth);
          return row;
        });
        // Reset DM history for new floor
        history = [{ role: 'system', content: DM_RESOLVE_PROMPT }];
        return { gen, tokens: respTokens };
      }

      messages.push(
        { role: 'assistant', content: respContent },
        { role: 'user', content: `Invalid map dimensions. Need exactly ${config.mapHeight} rows x ${config.mapWidth} columns each. Try again.` },
      );
    }

    // Fallback: generate a simple map
    return { gen: fallbackDungeon(config.mapWidth, config.mapHeight, floor), tokens: 0 };
  }

  async function resolve(state: GameState, heroAction: HeroAction): Promise<{ resolution: DMResolution; tokens: number }> {
    const stateStr = serializeState(state);
    const actionStr = `Hero action: ${JSON.stringify(heroAction)}`;

    // Keep sliding window of 10 turns
    if (history.length > 22) { // system + 10 pairs of (user, assistant)
      history = [history[0], ...history.slice(-20)];
    }

    history.push({ role: 'user', content: `${stateStr}\n\n${actionStr}` });

    const resp = await provider.chat(history, undefined, config.dmModel);
    const respContent = resp.content ?? '';
    const respTokens = resp.usage?.total_tokens ?? 0;
    const fallback: DMResolution = {
      narration: 'Nothing happens.',
      hero_damage: 0, hero_heal: 0, items_gained: [],
      entity_moves: [], entity_damage: [], killed_entities: [],
      map_changes: [], new_entities: [],
      game_over: false, victory: false, game_over_reason: '',
    };
    const resolution = parseJSON<DMResolution>(respContent, fallback);

    history.push({ role: 'assistant', content: respContent });

    return { resolution, tokens: respTokens };
  }

  return { generateDungeon, resolve };
}

// ─── Hero Agent ──────────────────────────────────────────────────────────────

const HERO_SYSTEM_PROMPT = `You are a brave adventurer trapped in a dangerous dungeon. Your goal: reach the exit (>) alive.

MAP LEGEND:
  @ = You (hero)    # = Wall (impassable)    . = Floor (walkable)
  + = Door (walkable)    < = Entrance    > = Exit (YOUR GOAL!)
  Uppercase letters = Monsters (hostile!)    $ = Treasure

ACTIONS (respond with one):
  {"thinking":"...","action":"move","direction":"north|south|east|west"}
  {"thinking":"...","action":"attack","target":"entity_id"}
  {"thinking":"...","action":"wait"}
  {"thinking":"...","action":"use","item":"item_name"}

MOVEMENT: north=up(y-1), south=down(y+1), east=right(x+1), west=left(x-1).

STRATEGY:
- Find the exit (>) to win. Navigate around walls.
- Avoid fighting multiple monsters simultaneously.
- Attack monsters when they block your path or are adjacent.
- Manage HP carefully — retreat if low.
- Think step by step about the best path to the exit.

Respond with ONLY valid JSON (no markdown, no extra text).`;

export function createHero(provider: LLMProvider, config: GameConfig) {
  let history: Message[] = [{ role: 'system', content: HERO_SYSTEM_PROMPT }];

  function resetHistory() {
    history = [{ role: 'system', content: HERO_SYSTEM_PROMPT }];
  }

  async function decide(state: GameState): Promise<{ action: HeroAction; tokens: number }> {
    const stateStr = serializeState(state);

    // Sliding window
    if (history.length > 12) {
      history = [history[0], ...history.slice(-10)];
    }

    history.push({ role: 'user', content: `${stateStr}\n\nDecide your action. Respond with ONLY JSON.` });

    const resp = await provider.chat(history, undefined, config.heroModel);
    const respContent = resp.content ?? '';
    const respTokens = resp.usage?.total_tokens ?? 0;
    const fallback: HeroAction = { thinking: 'I will wait.', action: 'wait' };
    const action = parseJSON<HeroAction>(respContent, fallback);

    history.push({ role: 'assistant', content: respContent });

    return { action, tokens: respTokens };
  }

  return { decide, resetHistory };
}

// ─── Fallback Dungeon ────────────────────────────────────────────────────────

function fallbackDungeon(w: number, h: number, floor: number): DungeonGen {
  const map: string[] = [];
  for (let y = 0; y < h; y++) {
    if (y === 0 || y === h - 1) {
      map.push('#'.repeat(w));
    } else {
      const row = '#' + '.'.repeat(w - 2) + '#';
      map.push(row);
    }
  }
  // Place entrance and exit
  const mapArr = map.map(r => [...r]);
  mapArr[1][1] = '<';
  mapArr[h - 2][w - 2] = '>';
  // Add a wall partition with door
  const midX = Math.floor(w / 2);
  for (let y = 1; y < h - 1; y++) {
    if (y === Math.floor(h / 2)) mapArr[y][midX] = '+';
    else mapArr[y][midX] = '#';
  }
  const finalMap = mapArr.map(r => r.join(''));

  const entities: Entity[] = [
    { id: 'goblin_1', name: 'Goblin', symbol: 'G', x: midX - 2, y: Math.floor(h / 2), hp: 6, max_hp: 6, attack: 2, hostile: true },
  ];

  return {
    map: finalMap,
    entities,
    hero_start: [1, 1],
    narration: `Floor ${floor}. A simple chamber stretches before you.`,
  };
}
