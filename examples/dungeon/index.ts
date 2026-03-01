#!/usr/bin/env npx tsx
// ─── LLM Dungeon Roguelike ──────────────────────────────────────────────────
//
// A roguelike where two LLM agents oppose each other:
//   Hero Agent  → decides actions each turn (move, attack, wait)
//   DM Agent    → IS the environment, generates dungeons, resolves everything
//
// The DM replaces traditional simulation entirely.
// No pathfinding algorithms, no physics — just LLM reasoning.
//
// Usage:
//   OPENAI_API_KEY=sk-... npx tsx examples/dungeon/index.ts
//
// Options (env vars):
//   OPENAI_BASE_URL  — for OpenRouter, Ollama, etc.
//   DM_MODEL         — model for DM (default: gpt-4o)
//   HERO_MODEL       — model for Hero (default: gpt-4o)
//   MAP_WIDTH        — dungeon width (default: 30)
//   MAP_HEIGHT       — dungeon height (default: 16)
//   MAX_TURNS        — turns per floor (default: 50)
//   MAX_FLOORS       — floors to clear for victory (default: 3)
//   TURN_DELAY       — ms between turns (default: 500)

import { createOpenAIProvider } from '../../src/index.js';
import { createDM, createHero } from './agents.js';
import {
  renderTitle, renderFrame, renderGameOver,
  renderHeroThinking, renderDMNarration,
} from './render.js';
import type { GameState, GameConfig, HeroAction, DMResolution } from './types.js';

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig(): GameConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is required.');
    console.error('Usage: OPENAI_API_KEY=sk-... npx tsx examples/dungeon/index.ts');
    process.exit(1);
  }
  return {
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL,
    dmModel:    process.env.DM_MODEL    || 'gpt-4o',
    heroModel:  process.env.HERO_MODEL  || 'gpt-4o',
    mapWidth:   parseInt(process.env.MAP_WIDTH  || '30', 10),
    mapHeight:  parseInt(process.env.MAP_HEIGHT || '16', 10),
    maxTurns:   parseInt(process.env.MAX_TURNS  || '50', 10),
    maxFloors:  parseInt(process.env.MAX_FLOORS || '3',  10),
    turnDelay:  parseInt(process.env.TURN_DELAY || '500', 10),
  };
}

// ─── Game State ──────────────────────────────────────────────────────────────

function createGameState(config: GameConfig, floor: number): GameState {
  return {
    map: [],
    width: config.mapWidth,
    height: config.mapHeight,
    hero: {
      x: 1, y: 1,
      hp: 20, max_hp: 20,
      attack: 5, defense: 2,
      items: [],
      level: 1,
    },
    entities: [],
    floor,
    turn: 0,
    maxTurns: config.maxTurns,
    log: [],
    gameOver: false,
    victory: false,
    totalTokens: 0,
  };
}

// ─── Hero Movement ───────────────────────────────────────────────────────────

const DIRECTIONS: Record<string, [number, number]> = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
};

function applyHeroMovement(state: GameState, action: HeroAction): GameState {
  if (action.action !== 'move' || !action.direction) return state;

  const delta = DIRECTIONS[action.direction];
  if (!delta) return state;

  const nx = state.hero.x + delta[0];
  const ny = state.hero.y + delta[1];

  // Bounds check
  if (nx < 0 || nx >= state.width || ny < 0 || ny >= state.height) return state;

  // Wall collision
  const tile = state.map[ny]?.[nx];
  if (tile === '#') {
    state.log.push(`You bump into a wall.`);
    return state;
  }

  // Entity collision (can't walk through monsters)
  const blocking = state.entities.find(e => e.hp > 0 && e.x === nx && e.y === ny);
  if (blocking) {
    state.log.push(`${blocking.name} blocks your path!`);
    return state;
  }

  // Move
  state.hero.x = nx;
  state.hero.y = ny;
  return state;
}

// ─── Apply DM Resolution ────────────────────────────────────────────────────

function applyDMResolution(state: GameState, dm: DMResolution): GameState {
  // Hero damage/heal
  if (dm.hero_damage > 0) {
    state.hero.hp = Math.max(0, state.hero.hp - dm.hero_damage);
  }
  if (dm.hero_heal > 0) {
    state.hero.hp = Math.min(state.hero.max_hp, state.hero.hp + dm.hero_heal);
  }

  // Items gained
  if (dm.items_gained?.length > 0) {
    state.hero.items.push(...dm.items_gained);
  }

  // Entity moves
  if (dm.entity_moves) {
    for (const move of dm.entity_moves) {
      const entity = state.entities.find(e => e.id === move.id);
      if (entity && entity.hp > 0) {
        // Validate move target is walkable
        const tile = state.map[move.y]?.[move.x];
        if (tile && tile !== '#' && move.x >= 0 && move.x < state.width && move.y >= 0 && move.y < state.height) {
          entity.x = move.x;
          entity.y = move.y;
        }
      }
    }
  }

  // Entity damage
  if (dm.entity_damage) {
    for (const dmg of dm.entity_damage) {
      const entity = state.entities.find(e => e.id === dmg.id);
      if (entity) {
        entity.hp = Math.max(0, entity.hp - dmg.damage);
      }
    }
  }

  // Killed entities
  if (dm.killed_entities) {
    for (const id of dm.killed_entities) {
      const entity = state.entities.find(e => e.id === id);
      if (entity) entity.hp = 0;
    }
  }

  // Map changes
  if (dm.map_changes) {
    for (const change of dm.map_changes) {
      if (change.y >= 0 && change.y < state.height && change.x >= 0 && change.x < state.width) {
        const row = [...state.map[change.y]];
        row[change.x] = change.tile;
        state.map[change.y] = row.join('');
      }
    }
  }

  // New entities
  if (dm.new_entities) {
    state.entities.push(...dm.new_entities);
  }

  // Narration
  if (dm.narration) {
    state.log.push(dm.narration);
  }

  // Game over conditions
  if (dm.game_over) {
    state.gameOver = true;
    state.victory = dm.victory;
    if (dm.game_over_reason) {
      state.log.push(dm.game_over_reason);
    }
  }

  // Engine-side game over check: hero HP <= 0
  if (state.hero.hp <= 0) {
    state.gameOver = true;
    state.victory = false;
  }

  // Engine-side victory check: hero on exit tile
  const heroTile = state.map[state.hero.y]?.[state.hero.x];
  if (heroTile === '>') {
    state.gameOver = true;
    state.victory = true;
    state.log.push('You reach the exit!');
  }

  return state;
}

// ─── Delay ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Main Game Loop ──────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();

  console.log(renderTitle());

  const provider = createOpenAIProvider({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultModel: config.dmModel,
  });

  const dm = createDM(provider, config);
  const hero = createHero(provider, config);

  let totalTokens = 0;

  for (let floor = 1; floor <= config.maxFloors; floor++) {
    console.log(`\n\x1b[36m  Generating floor ${floor}... (DM is thinking)\x1b[0m\n`);

    // DM generates dungeon
    const { gen, tokens: genTokens } = await dm.generateDungeon(floor);
    totalTokens += genTokens;

    // Initialize state
    const state = createGameState(config, floor);
    state.map = gen.map;
    state.entities = gen.entities || [];
    state.hero.x = gen.hero_start?.[0] ?? 1;
    state.hero.y = gen.hero_start?.[1] ?? 1;
    state.totalTokens = totalTokens;
    state.log.push(gen.narration || `You enter floor ${floor}.`);

    // Scale hero for deeper floors
    if (floor > 1) {
      state.hero.max_hp = 20 + (floor - 1) * 5;
      state.hero.hp = state.hero.max_hp;
      state.hero.attack = 5 + (floor - 1) * 2;
      state.hero.defense = 2 + (floor - 1);
    }

    // Render initial state
    console.log(renderFrame(state));
    console.log('');

    // Reset hero history for new floor
    hero.resetHistory();

    // Turn loop
    while (!state.gameOver && state.turn < state.maxTurns) {
      state.turn++;

      await sleep(config.turnDelay);

      // 1. Hero decides
      console.log(`\x1b[90m--- Turn ${state.turn} ---\x1b[0m`);
      const { action, tokens: heroTokens } = await hero.decide(state);
      totalTokens += heroTokens;
      state.totalTokens = totalTokens;

      const actionDesc = action.action === 'move' ? `move ${action.direction}`
        : action.action === 'attack' ? `attack ${action.target}`
        : action.action === 'use' ? `use ${action.item}`
        : action.action;

      console.log(renderHeroThinking(
        action.thinking || '...',
        actionDesc,
      ));

      // 2. Apply hero movement (engine-side)
      applyHeroMovement(state, action);

      // 3. DM resolves everything else
      const { resolution, tokens: dmTokens } = await dm.resolve(state, action);
      totalTokens += dmTokens;
      state.totalTokens = totalTokens;

      // 4. Apply DM resolution
      applyDMResolution(state, resolution);

      // 5. Render
      console.log(renderDMNarration(resolution.narration || ''));
      console.log('');
      console.log(renderFrame(state));
      console.log('');
    }

    // Floor result
    if (state.victory && floor < config.maxFloors) {
      console.log(`\x1b[32m  Floor ${floor} cleared! Descending deeper...\x1b[0m\n`);
      continue;
    }

    // Game over (death or final floor cleared)
    if (!state.victory || floor === config.maxFloors) {
      if (!state.victory && state.turn >= state.maxTurns) {
        state.log.push('Time ran out! The dungeon collapses.');
        state.gameOver = true;
      }
      console.log(renderGameOver(state));
      break;
    }
  }

  console.log(`\x1b[90m  Total LLM tokens consumed: ${totalTokens}\x1b[0m`);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
