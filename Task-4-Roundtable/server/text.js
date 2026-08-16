// The screen every user-supplied string goes through before it reaches a
// query.
//
// NUL is the one that has to be caught: Postgres cannot store 0x00 in a text
// column at all and answers `invalid byte sequence for encoding "UTF8": 0x00`,
// which reached the client as a 500 for what is plainly a bad request. The
// rest of the C0 range and DEL are storable but render as nothing, so a name
// made of them is blank everywhere it is shown and impossible to tell apart
// from anyone else's.
//
// Tab, newline and carriage return are the exception, and only where they were
// meant: a post body or a description may have line breaks in it, a name may
// not. Callers say which they are with { allowBreaks: true }.

const CONTROLS = /[\u0000-\u001f\u007f]/;
const CONTROLS_EXCEPT_BREAKS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function hasControlChars(value, { allowBreaks = false } = {}) {
  return (allowBreaks ? CONTROLS_EXCEPT_BREAKS : CONTROLS).test(String(value));
}

// One wording for all of them, because to the person typing it is one mistake
// wherever they made it.
const CONTROL_CHARS_ERROR = 'That contains characters that cannot be saved. Please remove them and try again.';

module.exports = { hasControlChars, CONTROL_CHARS_ERROR };
