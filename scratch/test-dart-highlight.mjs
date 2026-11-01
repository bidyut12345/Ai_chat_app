import '../public/highlight.js';

console.log('Language for main.dart:', globalThis.detectLanguage('main.dart'));
console.log('Language for test/engine/loan_math.dart:', globalThis.detectLanguage('test/engine/loan_math.dart'));

const sampleDart = `import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    const int count = 42;
    final double rate = 8.5;
    return Container();
  }
}`;

const lines = globalThis.highlightToLines(sampleDart, 'dart');
console.log('Total highlighted lines:', lines.length);
lines.forEach((l, i) => console.log(`Line ${i + 1}: ${l}`));
