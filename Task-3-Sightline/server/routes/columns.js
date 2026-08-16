const express = require('express');
const { COLUMNS } = require('../statuses');

// The browser asks for the board's columns rather than hard-coding them, so
// adding one is a change to server/statuses.js and nothing else.
const router = express.Router();

router.get('/', (req, res) => res.json(COLUMNS));

module.exports = router;
