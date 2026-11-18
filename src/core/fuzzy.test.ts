import { describe, expect, it } from 'vitest';
import { closestNames, nameSimilarity, soundKey } from './fuzzy.js';

const roster = ['Grasso', 'Fontana', 'Okafor', 'Vasquez', 'Hughes', 'Petrov', 'Keller', 'Ricci', 'Bailey', 'Tran', 'Delgado', 'Whitfield'];
const best = (heard: string) => closestNames(heard, roster, (n) => [n]).map((x) => x.item);

describe('names heard, not typed', () => {
  it('finds the client a speech recognizer mangled', () => {
    expect(best('grass oh')[0]).toBe('Grasso');
    expect(best('Graso')[0]).toBe('Grasso');
    expect(best('oak afore')[0]).toBe('Okafor');
    expect(best("Vasquez's")[0]).toBe('Vasquez');
    expect(best('Vaskez')[0]).toBe('Vasquez');
    expect(best('Richie')[0]).toBe('Ricci');
    expect(best('Petroff')[0]).toBe('Petrov');
    expect(best('Fontanna')[0]).toBe('Fontana');
  });
  it('does not invent a match for a name that is simply not there', () => {
    expect(best('Rodriguez')).toEqual([]);
    expect(best('Smith')).toEqual([]);
    expect(best('calendar')).toEqual([]);
  });
  it('sound keys merge look-alike spellings', () => {
    expect(soundKey('Vasquez')).toBe(soundKey('Vaskes'));
    expect(nameSimilarity('Kellar', 'Keller')).toBeGreaterThan(0.8);
  });
});
