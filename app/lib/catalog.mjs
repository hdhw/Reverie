import fs from 'node:fs';
import path from 'node:path';
import { ROOT, publicUrl as hostUrl } from './config.mjs';
import { SERVER_DIR } from './deps.mjs';

const VENDOR = path.join(ROOT, 'vendor');
const DATA = path.join(SERVER_DIR, 'Data');

// Source file (under vendor/<source>) -> target files under server/Data.
export const SOURCES = {
  // What Mocha's 2023 client was actually played on.
  'mocha-2023': {
    'Items/AvatarItems.json': ['APIS/Items/AvatarItems.json'],
    'Items/AvatarItemsDefault.json': ['APIS/Items/AvatarItemsDefault.json'],
    'Items/Equipment.json': ['APIS/Items/Equipment.json'],
    'Items/EquipmentDefault.json': ['APIS/Items/EquipmentDefault.json'],
    'Items/Consumables.json': ['APIS/Items/Consumables.json'],
    'Items/ConsumablesDefault.json': ['APIS/Items/ConsumablesDefault.json'],
    'GameConfigs.json': ['APIS/GameConfigs.json'],
    'Imports/ImportRooms.json': ['Imports/ImportRooms.json'],
  },
  // 2016-2020 era data; Default* copies unlock everything, as RebornRec does.
  rebornrec: {
    'avataritems.txt': ['APIS/Items/AvatarItems.json', 'APIS/Items/AvatarItemsDefault.json'],
    'equipment.txt': ['APIS/Items/Equipment.json'],
    'consumables.txt': ['APIS/Items/Consumables.json', 'APIS/Items/ConsumablesDefault.json'],
    'gameconfigs.txt': ['APIS/GameConfigs.json'],
  },
};

const TARGETS = [...new Set(Object.values(SOURCES['mocha-2023']).flat())];

export function catalogStatus() {
  return TARGETS.map(rel => {
    const file = path.join(DATA, rel);
    let items = null;
    try { items = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).length; } catch {}
    return { file: rel, present: fs.existsSync(file), items };
  });
}

// Copies missing data files in; never overwrites a host's edits unless forced.
export function importCatalog({ source = 'mocha-2023', force = false } = {}) {
  const map = SOURCES[source];
  if (!map) throw new Error(`Unknown catalog source "${source}". Use one of: ${Object.keys(SOURCES).join(', ')}`);
  const written = [];
  for (const [src, targets] of Object.entries(map)) {
    const raw = fs.readFileSync(path.join(VENDOR, source, src), 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error(`${source}/${src} is not a JSON array`);
    for (const rel of targets) {
      const file = path.join(DATA, rel);
      if (fs.existsSync(file) && !force) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, raw);
      written.push({ file: rel, items: data.length, source });
    }
  }
  return written;
}

// Rewritten every start so the client always gets this host's address and name.
export function renderGameConfig(cfg) {
  const publicUrl = hostUrl(cfg);
  const template = JSON.parse(fs.readFileSync(path.join(VENDOR, 'mocha-2023', 'ConfigV2.template.json'), 'utf8'));
  const fill = v => typeof v === 'string'
    ? v.replaceAll('{{PUBLIC_URL}}', publicUrl).replaceAll('{{MOTD}}', `Welcome to ${cfg.serverName}!`)
    : Array.isArray(v) ? v.map(fill)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
  const file = path.join(DATA, 'APIS', 'ConfigV2.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fill(template), null, 2));
}

if (process.argv[1] === import.meta.filename) {
  const source = process.argv.find(a => a.startsWith('--source='))?.slice(9) ?? 'mocha-2023';
  for (const w of importCatalog({ source, force: process.argv.includes('--force') })) console.log(`wrote ${w.file} (${w.items}) from ${w.source}`);
  console.table(catalogStatus());
}
