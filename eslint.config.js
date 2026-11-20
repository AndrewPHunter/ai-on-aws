// Type-aware lint for every TypeScript file in the repository. Run with --max-warnings 0.
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'it', 'describe'], package: 'node:test' }] },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
)
