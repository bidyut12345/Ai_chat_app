import fs from 'node:fs';

let css = fs.readFileSync('public/styles.css', 'utf8');
const target = '/* Per-message list of files a turn changed (under the user message). */';
const replacement = '/* Per-message list of files a turn changed (at the end of the generated assistant message). */';

if (!css.includes(target)) {
  console.error('Target comment not found');
  process.exit(1);
}

css = css.replace(target, replacement);
fs.writeFileSync('public/styles.css', css, 'utf8');
console.log('styles.css comment updated');

