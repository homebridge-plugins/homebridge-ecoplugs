import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Flat config for ESLint 10 + typescript-eslint.
// Named .mjs because package.json is CommonJS (the compiled plugin in dist/ must stay CJS).
export default defineConfig(
  // ignore patterns (replaces the old .eslintignore)
  { ignores: ['dist/**', 'node_modules/**'] },

  js.configs.recommended,
  tseslint.configs.recommended,

  // project-specific settings for TS source
  {
    files: ['src/**/*.ts'],
    rules: {
      quotes: ['warn', 'single'],
      // indenting throughout the project is four spaces, so match the codebase
      // indentation is already enforced by preexisting formatting; turn
      // off to avoid minor spacing mismatches.
      indent: 'off',
      semi: ['warn'],
      'comma-dangle': ['warn', 'always-multiline'],
      'dot-notation': 'off',
      eqeqeq: 'warn',
      // style rules are noisy for this large file and many single-line
      // constructs; disable them to keep lint output focused.
      curly: 'off',
      'brace-style': 'off',
      'prefer-arrow-callback': ['warn'],
      'max-len': ['warn', 140],
      'no-console': ['warn'], // use the provided Homebridge log method instead
      'comma-spacing': ['error'],
      // alignment in this codebase uses extra spaces for readability, so
      // the core rule generates a lot of noise.  disable it rather than
      // stripping intentional formatting.
      'no-multi-spaces': 'off',
      'no-trailing-spaces': ['warn'],
      'lines-between-class-members': ['warn', 'always', { exceptAfterSingleLine: true }],
      // Existing code uses `any` and a CommonJS require() for package.json.  These are
      // pre-existing debt surfaced by the working lint setup, so keep them visible as
      // warnings rather than failing CI.  TODO: type the protocol payloads and drop these.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // Tests run as CommonJS under Node's built-in test runner. Keep them in the
  // lint scope, but use their actual runtime globals and module style.
  {
    files: ['test/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        Buffer: 'readonly',
        __dirname: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
