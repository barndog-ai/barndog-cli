// Loaded before every test file (see the `test` script). Tests compare plain
// text, so output must not depend on the terminal running them: some terminals
// set FORCE_COLOR, which would otherwise color everything the CLI prints.
process.env.FORCE_COLOR = "0";
