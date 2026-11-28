/*
 * Wrapper ESM untuk dataset kota/kabupaten Indonesia (data/indonesia-cities.js)
 * agar backend Node.js memakai sumber koordinat & jenjang yang sama persis dengan frontend.
 */
import '../data/indonesia-cities.js';

const loc = globalThis.SIGI_LOCATIONS;

export const SCHOOL_LEVELS = loc.LEVELS;
export const INDONESIA_PROVINCES = loc.PROVINCES;
export const findIndonesianCity = loc.findCity;
export const projectToMap = loc.projectToMap;

export function normalizeSchoolLevel(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  const hit = SCHOOL_LEVELS.find((item) => item.toLowerCase() === clean.toLowerCase());
  return hit || '';
}

export function normalizeWebsiteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.href.slice(0, 300);
  } catch {
    return '';
  }
}
