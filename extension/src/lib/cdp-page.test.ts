import { describe, expect, it } from 'vitest';
import { exceptionText, renderArgs } from './cdp-page';

describe('renderArgs', () => {
  it('renders the common console.log shapes', () => {
    expect(renderArgs([{ type: 'string', value: 'saved' }, { type: 'number', value: 487 }])).toBe(
      'saved 487',
    );
  });

  it('falls back to description for objects, which is all CDP gives us', () => {
    expect(renderArgs([{ type: 'object', description: 'Error: boom' }])).toBe('Error: boom');
  });

  it('handles unserializable values rather than dropping them', () => {
    expect(renderArgs([{ type: 'number', unserializableValue: 'NaN' }])).toBe('NaN');
  });

  it('is empty for no args', () => {
    expect(renderArgs(undefined)).toBe('');
    expect(renderArgs([])).toBe('');
  });
});

describe('exceptionText', () => {
  it('splits the description into message and stack', () => {
    const r = exceptionText({
      text: 'Uncaught (in promise)',
      exception: {
        description: 'TypeError: x is not a function\n    at savePost (editor-bar.tsx:118:13)',
      },
    });
    expect(r.text).toBe('TypeError: x is not a function');
    expect(r.stack).toBe('at savePost (editor-bar.tsx:118:13)');
  });

  it('falls back to text when there is no description', () => {
    expect(exceptionText({ text: 'Script error.' })).toEqual({ text: 'Script error.' });
  });

  it('omits the stack when the description is a single line', () => {
    expect(exceptionText({ exception: { description: 'boom' } }).stack).toBeUndefined();
  });
});
