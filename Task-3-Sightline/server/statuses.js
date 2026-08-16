// The board's columns, defined once.
//
// This list used to exist in four places that could not see each other: the
// CHECK constraint in db/schema.sql, the validator in routes/tasks.js, the
// COLUMNS array in public/js/board.js, and the <option> values in board.html.
// Now db.js renders the CHECK from it, routes/columns.js serves it to the
// browser, and the board builds both its columns and the dialog's Column
// dropdown from what it is served.
const COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'In progress' },
  { key: 'review', label: 'In review' },
  { key: 'done', label: 'Done' },
];

const STATUSES = COLUMNS.map((column) => column.key);

const DEFAULT_STATUS = STATUSES[0];

function isStatus(value) {
  return STATUSES.includes(value);
}

// Rendered into db/schema.sql's {{STATUSES}} placeholder. The keys are our own
// literals, but they are quoted properly anyway so the generated SQL stays
// valid whatever anyone adds to the list above.
function statusSqlList() {
  return STATUSES.map((key) => `'${key.replace(/'/g, "''")}'`).join(', ');
}

module.exports = { COLUMNS, STATUSES, DEFAULT_STATUS, isStatus, statusSqlList };
