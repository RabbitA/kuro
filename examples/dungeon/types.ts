// ─── LLM Dungeon Roguelike: Type Definitions ────────────────────────────────
//
// Two LLM agents oppose each other:
//   Hero Agent  → explores, fights, survives
//   DM Agent    → IS the environment, generates and evolves the world
//
// The DM replaces traditional simulation — no pathfinding, no physics engine,
// just an LLM reasoning about what should happen next.

// ─── Core ────────────────────────────────────────────────────────────────────

export interface Position {
  x: number;
  y: number;
}

export interface Entity {
  id: string;
  name: string;
  symbol: string; // single char: G=goblin S=skeleton B=bat R=rat O=ogre D=demon
  x: number;
  y: number;
  hp: number;
  max_hp: number;
  attack: number;
  hostile: boolean;
}

export interface Hero {
  x: number;
  y: number;
  hp: number;
  max_hp: number;
  attack: number;
  defense: number;
  items: string[];
  level: number;
}

export interface GameState {
  map: string[];       // array of strings, each row of the dungeon
  width: number;
  height: number;
  hero: Hero;
  entities: Entity[];
  floor: number;
  turn: number;
  maxTurns: number;
  log: string[];       // narrative event log
  gameOver: boolean;
  victory: boolean;
  totalTokens: number;
}

// ─── Agent I/O ───────────────────────────────────────────────────────────────

export interface DungeonGen {
  map: string[];
  entities: Entity[];
  hero_start: number[]; // [x, y]
  narration: string;
}

export interface HeroAction {
  thinking: string;
  action: 'move' | 'attack' | 'wait' | 'use' | 'inspect';
  direction?: 'north' | 'south' | 'east' | 'west';
  target?: string;
  item?: string;
}

export interface DMResolution {
  narration: string;
  hero_damage: number;
  hero_heal: number;
  items_gained: string[];
  entity_moves: Array<{ id: string; x: number; y: number }>;
  entity_damage: Array<{ id: string; damage: number }>;
  killed_entities: string[];
  map_changes: Array<{ x: number; y: number; tile: string }>;
  new_entities: Entity[];
  game_over: boolean;
  victory: boolean;
  game_over_reason: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface GameConfig {
  apiKey: string;
  baseURL?: string;
  dmModel: string;
  heroModel: string;
  mapWidth: number;
  mapHeight: number;
  maxTurns: number;
  maxFloors: number;
  turnDelay: number; // ms between turns
}
