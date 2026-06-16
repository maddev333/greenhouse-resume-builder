"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateId = generateId;
exports.makeBulletSignature = makeBulletSignature;
exports.normalizeEmployerName = normalizeEmployerName;
exports.normalizeDate = normalizeDate;
exports.normalizeString = normalizeString;
exports.dedupNames = dedupNames;
const crypto_1 = __importDefault(require("crypto"));
/** Generate a v4-style UUID */
function generateId() {
    return crypto_1.default.randomUUID();
}
/** Create a stable bullet signature for diffing via SHA-256 of normalized text */
function makeBulletSignature(text) {
    return crypto_1.default.createHash('sha256').update(text).digest('hex');
}
/** Normalize employer names: trim, lowercase, collapse whitespace, remove punctuation variants */
function normalizeEmployerName(name) {
    return name.trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
}
/** Normalize dates to year-month when possible (e.g. "2019-03" or "2019-00") */
function normalizeDate(dateStr) {
    const m = dateStr.match(/^(\d{4})[-/]?.*?(\d{1,2})/);
    if (m)
        return `${m[1]}-${String(Math.min(parseInt(m[2]), 12)).padStart(2, '0')}`;
    const y = dateStr.match(/^(\d{4})/);
    if (y)
        return `${y[1]}-00`;
    return dateStr.trim().toLowerCase();
}
/** Normalize strings: trim, lowercase, collapse whitespace */
function normalizeString(s) {
    return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
/** Deduplicate names using similarity matching. Returns unique names and any near-duplicates found. */
function dedupNames(names) {
    const seen = new Set();
    const similarities = [];
    const unique = names.filter((name, i) => {
        const normed = normalizeString(name);
        if (seen.has(normed))
            return false;
        seen.add(normed);
        // Check similarity with earlier accepted names
        for (let j = 0; j < i; j++) {
            const other = normalizeString(names[j]);
            if (other.length !== 0 && name.length !== other.length && Math.abs(name.length - other.length) > 10)
                continue;
            // Simple substring / similarity check as heuristic
            if (normed.includes(other) || other.includes(normed)) {
                similarities.push({ nameA: names[j], nameB: name, score: 0.8 });
            }
        }
        return true;
    });
    return { unique, similarities };
}
//# sourceMappingURL=utils.js.map