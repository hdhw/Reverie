import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { SERVER_DIR } from './deps.mjs';

const DATA = path.join(SERVER_DIR, 'Data');
const IMAGES = path.join(DATA, 'Images');
const UPLOADS = 'Reverie';
const LOADING = path.join(DATA, 'loadingscreen.json');
const BOARD = path.join(DATA, 'communityboard.json');
const VENDOR_IMAGES = path.join(ROOT, 'vendor', 'femrec-2023', 'Images');
const IMAGE_EXT = /\.(png|jpe?g)$/i;

export const DEFAULT_LOADING = [
  {
    ImageName: 'RROs/DormRoom.jpg',
    Title: 'Setup your Reverie server!',
    Message: 'This server runs on Reverie. Its host can change these loading screens in the Reverie panel, under Customize.',
    PlatformMask: -1,
    RoomNames: [],
  },
];

export const DEFAULT_BOARD = {
  featuredPlayer: null,
  featuredRoomGroup: null,
  instagramImages: [],
  videos: [],
  currentAnnouncement: { message: 'Setup your Reverie server! Hosts edit this board in the Reverie panel, under Customize.', moreInfoUrl: '' },
};

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return structuredClone(fallback); }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

// Copies bundled images and default screens in without touching anything the host changed.
export function installContent() {
  const copied = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(src); continue; }
      const dest = path.join(IMAGES, path.relative(VENDOR_IMAGES, src));
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied.push(path.relative(IMAGES, dest));
    }
  };
  if (fs.existsSync(VENDOR_IMAGES)) walk(VENDOR_IMAGES);
  if (!fs.existsSync(LOADING)) writeJson(LOADING, DEFAULT_LOADING);
  if (!fs.existsSync(BOARD)) writeJson(BOARD, DEFAULT_BOARD);
  return copied;
}

export function listImages() {
  const out = [];
  for (const dir of ['RROs', UPLOADS]) {
    const full = path.join(IMAGES, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) if (IMAGE_EXT.test(f)) out.push(`${dir}/${f}`);
  }
  return out;
}

export function imagePath(name) {
  const file = path.resolve(IMAGES, String(name ?? ''));
  if (!file.startsWith(IMAGES + path.sep) || !IMAGE_EXT.test(file) || !fs.existsSync(file)) return null;
  return file;
}

export function saveImage(name, base64) {
  const buf = Buffer.from(String(base64 ?? ''), 'base64');
  const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!png && !jpg) throw new Error('Upload a PNG or JPEG image.');
  if (buf.length > 6 * 1024 * 1024) throw new Error('Images must be 6 MB or smaller.');
  const base = String(name ?? '').replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
  const rel = `${UPLOADS}/${base}-${Date.now().toString(36)}.${png ? 'png' : 'jpg'}`;
  fs.mkdirSync(path.join(IMAGES, UPLOADS), { recursive: true });
  fs.writeFileSync(path.join(IMAGES, rel), buf);
  return rel;
}

const clean = (v, max) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

export const getLoadingScreens = () => {
  const list = readJson(LOADING, DEFAULT_LOADING);
  return Array.isArray(list) ? list : structuredClone(DEFAULT_LOADING);
};

export function setLoadingScreens(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 30) throw new Error('Keep between 1 and 30 loading screens.');
  const known = new Set(listImages());
  const next = list.map((s, i) => {
    const title = clean(s.Title, 60);
    if (!title) throw new Error(`Loading screen ${i + 1} needs a title.`);
    const image = String(s.ImageName ?? '');
    if (!known.has(image)) throw new Error(`Loading screen ${i + 1} uses an image that doesn't exist.`);
    return { ImageName: image, Title: title, Message: clean(s.Message, 300), PlatformMask: -1, RoomNames: [] };
  });
  writeJson(LOADING, next);
  return next;
}

export const getBoard = () => readJson(BOARD, DEFAULT_BOARD);

export function setBoard({ message, moreInfoUrl }) {
  const url = clean(moreInfoUrl, 300);
  if (url && !/^https?:\/\//i.test(url)) throw new Error('The link must start with http:// or https://');
  const board = { ...getBoard(), currentAnnouncement: { message: clean(message, 500), moreInfoUrl: url } };
  writeJson(BOARD, board);
  return board;
}
