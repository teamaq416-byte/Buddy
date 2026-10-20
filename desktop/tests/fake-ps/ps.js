#!/usr/bin/env node
// Fake powershell.exe for tests: dictation prints a sentence, the wake loop prints one hit then idles, key taps succeed.
const cmd = process.argv.slice(2).join(' ');
if (/DictationGrammar/.test(cmd)) { process.stdout.write('hello from the microphone'); process.exit(0); }
if (/GrammarBuilder/.test(cmd)) { process.stdout.write('WAKE 0.91\n'); setInterval(() => {}, 1000); }
else if (/keybd_event/.test(cmd)) { process.exit(0); }
else process.exit(0);
