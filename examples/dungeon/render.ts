// ─── LLM Dungeon Roguelike: ASCII Renderer ──────────────────────────────────

import type { GameState } from './types.js';

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
} as const;

function colorChar(ch: string): string {
  switch (ch) {
    case '#': return `${C.gray}#${C.reset}`;
    case '.': return `${C.dim}.${C.reset}`;
    case '+': return `${C.yellow}+${C.reset}`;
    case '<': return `${C.cyan}<${C.reset}`;
    case '>': return `${C.bold}${C.cyan}>${C.reset}`;
    case '~': return `${C.blue}~${C.reset}`;
    case '^': return `${C.red}^${C.reset}`;
    case '@': return `${C.bold}${C.green}@${C.reset}`;
    case '$': return `${C.bold}${C.yellow}$${C.reset}`;
    default:
      // Uppercase = monster
      if (ch >= 'A' && ch <= 'Z') return `${C.bold}${C.red}${ch}${C.reset}`;
      return ch;
  }
}

function colorizeLine(line: string): string {
  return [...line].map(colorChar).join('');
}

// ─── HP Bar ──────────────────────────────────────────────────────────────────

function hpBar(current: number, max: number, width: number = 20): string {
  const filled = Math.round((current / max) * width);
  const empty = width - filled;
  const bar = '#'.repeat(filled) + '.'.repeat(empty);
  const color = filled > width * 0.5 ? C.green : filled > width * 0.25 ? C.yellow : C.red;
  return `${color}[${bar}]${C.reset}`;
}

// ─── Composite Map ───────────────────────────────────────────────────────────

function compositeMap(state: GameState): string[] {
  const display = state.map.map(row => [...row]);

  for (const e of state.entities) {
    if (e.hp > 0 && e.y >= 0 && e.y < state.height && e.x >= 0 && e.x < state.width) {
      display[e.y][e.x] = e.symbol;
    }
  }

  if (state.hero.y >= 0 && state.hero.y < state.height &&
      state.hero.x >= 0 && state.hero.x < state.width) {
    display[state.hero.y][state.hero.x] = '@';
  }

  return display.map(row => row.join(''));
}

// ─── Render Frame ────────────────────────────────────────────────────────────

export function renderFrame(state: GameState): string {
  const mapLines = compositeMap(state);
  const contentWidth = Math.max(state.width, 40);
  const pad = (s: string, rawLen: number) => s + ' '.repeat(Math.max(0, contentWidth - rawLen));

  const lines: string[] = [];
  const border = '─'.repeat(contentWidth + 2);

  // Header
  const headerText = `Floor ${state.floor}  Turn ${state.turn}/${state.maxTurns}  Tokens: ${state.totalTokens}`;
  lines.push(`${C.cyan}┌${border}┐${C.reset}`);
  lines.push(`${C.cyan}│${C.reset} ${C.bold}${pad(headerText, headerText.length)}${C.reset} ${C.cyan}│${C.reset}`);

  // Stats
  const hp = hpBar(state.hero.hp, state.hero.max_hp);
  const statsText = `HP ${state.hero.hp}/${state.hero.max_hp}  ATK:${state.hero.attack}  DEF:${state.hero.defense}  Items:${state.hero.items.length > 0 ? state.hero.items.join(',') : 'none'}`;
  const hpRaw = `HP [${('#'.repeat(Math.round((state.hero.hp / state.hero.max_hp) * 20)))}${('.'.repeat(20 - Math.round((state.hero.hp / state.hero.max_hp) * 20)))}] ${statsText}`;
  lines.push(`${C.cyan}│${C.reset} ${hp} ${statsText}${' '.repeat(Math.max(0, contentWidth - 24 - statsText.length))} ${C.cyan}│${C.reset}`);

  // Map separator
  lines.push(`${C.cyan}├${border}┤${C.reset}`);

  // Map
  for (const row of mapLines) {
    const colored = colorizeLine(row);
    const padding = ' '.repeat(Math.max(0, contentWidth - row.length));
    lines.push(`${C.cyan}│${C.reset} ${colored}${padding} ${C.cyan}│${C.reset}`);
  }

  // Entity list
  const aliveEntities = state.entities.filter(e => e.hp > 0);
  if (aliveEntities.length > 0) {
    lines.push(`${C.cyan}├${border}┤${C.reset}`);
    for (const e of aliveEntities) {
      const eInfo = `${e.symbol} ${e.name} HP:${e.hp}/${e.max_hp} ATK:${e.attack} (${e.x},${e.y})`;
      lines.push(`${C.cyan}│${C.reset} ${C.red}${pad(eInfo, eInfo.length)}${C.reset} ${C.cyan}│${C.reset}`);
    }
  }

  // Event log
  const recentLog = state.log.slice(-4);
  if (recentLog.length > 0) {
    lines.push(`${C.cyan}├${border}┤${C.reset}`);
    for (const entry of recentLog) {
      const truncated = entry.length > contentWidth ? entry.slice(0, contentWidth - 3) + '...' : entry;
      lines.push(`${C.cyan}│${C.reset} ${C.dim}${pad(truncated, truncated.length)}${C.reset} ${C.cyan}│${C.reset}`);
    }
  }

  lines.push(`${C.cyan}└${border}┘${C.reset}`);
  return lines.join('\n');
}

// ─── Title Screen ────────────────────────────────────────────────────────────

export function renderTitle(): string {
  return `
${C.cyan}${C.bold}
    ╦  ╦  ╔╦╗   ╔╦╗ ╦ ╦ ╔╗╔ ╔═╗ ╔═╗ ╔═╗ ╔╗╔
    ║  ║   ║║    ║║║ ║ ║ ║║║ ║ ╦ ║╣  ║ ║ ║║║
    ╩═╝╩═╝╩ ╩   ═╩╝ ╚═╝ ╝╚╝ ╚═╝ ╚═╝ ╚═╝ ╝╚╝
${C.reset}
${C.dim}    Two AIs enter the dungeon. One generates the world.
    One tries to survive. No simulation — pure LLM reasoning.${C.reset}

${C.yellow}    Hero Agent${C.reset} vs ${C.red}DM Agent${C.reset}
${C.dim}    ─────────────────────────────────────────────────${C.reset}
`;
}

// ─── Game Over Screen ────────────────────────────────────────────────────────

export function renderGameOver(state: GameState): string {
  const lines: string[] = [];
  lines.push('');

  if (state.victory) {
    lines.push(`${C.bold}${C.green}  ╔═══════════════════════════════╗${C.reset}`);
    lines.push(`${C.bold}${C.green}  ║     HERO ESCAPED THE DUNGEON ║${C.reset}`);
    lines.push(`${C.bold}${C.green}  ╚═══════════════════════════════╝${C.reset}`);
    lines.push(`${C.green}  The Hero Agent outwitted the DM!${C.reset}`);
  } else {
    lines.push(`${C.bold}${C.red}  ╔═══════════════════════════════╗${C.reset}`);
    lines.push(`${C.bold}${C.red}  ║       HERO HAS FALLEN        ║${C.reset}`);
    lines.push(`${C.bold}${C.red}  ╚═══════════════════════════════╝${C.reset}`);
    lines.push(`${C.red}  The DM Agent claimed another soul.${C.reset}`);
  }

  lines.push('');
  lines.push(`${C.dim}  Final stats:${C.reset}`);
  lines.push(`${C.dim}    Floor: ${state.floor}  Turns: ${state.turn}  HP: ${state.hero.hp}/${state.hero.max_hp}${C.reset}`);
  lines.push(`${C.dim}    Total LLM tokens used: ${state.totalTokens}${C.reset}`);
  lines.push('');

  return lines.join('\n');
}

// ─── Agent Thinking Display ──────────────────────────────────────────────────

export function renderHeroThinking(thinking: string, action: string): string {
  const lines: string[] = [];
  lines.push(`${C.green}[Hero]${C.reset} ${C.dim}${thinking}${C.reset}`);
  lines.push(`${C.green}[Hero]${C.reset} ${C.bold}Action: ${action}${C.reset}`);
  return lines.join('\n');
}

export function renderDMNarration(narration: string): string {
  return `${C.red}[DM]${C.reset} ${C.dim}${narration}${C.reset}`;
}
