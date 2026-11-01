import fs from 'node:fs';

let code = fs.readFileSync('public/highlight.js', 'utf8');

// 1. Add dart to LANG_NAMES
const langNameTarget = "    markdown: 'Markdown',";
const langNameReplacement = "    markdown: 'Markdown',\r\n    dart: 'Dart',";
if (!code.includes(langNameTarget)) {
  console.error('langNameTarget not found in public/highlight.js');
  process.exit(1);
}
code = code.replace(langNameTarget, langNameReplacement);

// 2. Add dart extension mapping in detectLanguage
const extTarget = "      tsx: 'typescript',";
const extReplacement = "      tsx: 'typescript',\r\n      dart: 'dart',";
if (!code.includes(extTarget)) {
  console.error('extTarget not found in public/highlight.js');
  process.exit(1);
}
code = code.replace(extTarget, extReplacement);

// 3. Add dart syntax rules to RULES
const dartRules = [
  '    dart: [',
  '      { type: \'comment\', regex: /\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\//y },',
  '      { type: \'string\', regex: /r\'(?:[^\'\\\\]|\\\\.)*\'|r"(?:[^"\\\\]|\\\\.)*"|\'\'\'[\\s\\S]*?\'\'\'|"""[\\s\\S]*?"""|\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*"/y },',
  '      { type: \'number\', regex: /\\b(?:0x[a-fA-F0-9]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b/y },',
  '      { type: \'keyword\', regex: /\\b(?:abstract|as|assert|async|await|base|break|case|catch|class|const|continue|covariant|default|deferred|do|dynamic|else|enum|export|extends|extension|external|factory|false|final|finally|for|Function|get|hide|if|implements|import|in|interface|is|late|library|mixin|modifier|new|null|of|on|operator|part|rethrow|return|sealed|set|show|static|super|switch|sync|this|throw|true|try|typedef|var|void|when|while|with|yield)\\b/y },',
  '      { type: \'bool\', regex: /\\b(?:true|false|null)\\b/y },',
  '      { type: \'decorator\', regex: /@[a-zA-Z_$][a-zA-Z0-9_$]*/y },',
  '      { type: \'fn\', regex: /\\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\\s*\\()/y },',
  '      { type: \'type\', regex: /\\b(?:int|double|num|bool|String|List|Map|Set|Iterable|Future|Stream|Object|Type|Symbol|Never|Record|Widget|StatelessWidget|StatefulWidget|State|BuildContext|[A-Z][a-zA-Z0-9_$]*)\\b/y },',
  '      { type: \'op\', regex: /=>|\\?\\?=|\\?\\?|\\?\\.|\\?|\\.\\.|\\.\\.\\.|===|!==|==|!=|<=|>=|&&|\\|\\||\\+\\+|--|\\+=|-=|\\*=|\\/=|%=|&=|\\|=|\\^=|~\\/|[+\\-*\\/%&|^~<>!]/y },',
  '      { type: \'punct\', regex: /[{}()\\[\\];,.:]/y }',
  '    ],'
].join('\r\n');

const rulesTarget = '    javascript: [';
if (!code.includes(rulesTarget)) {
  console.error('rulesTarget not found in public/highlight.js');
  process.exit(1);
}
code = code.replace(rulesTarget, dartRules + '\r\n' + rulesTarget);

fs.writeFileSync('public/highlight.js', code, 'utf8');
console.log('Successfully added Dart support to public/highlight.js');

