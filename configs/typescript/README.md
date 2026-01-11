# TypeScript Configuration

Recommended TypeScript configuration for Node.js projects.

## Usage

Copy to your project root:

```bash
cp tsconfig.json ../../tsconfig.json
```

## Key Settings

### Strict Mode

All strict checks enabled:
- `strict: true` - Enable all strict type checks
- `noImplicitAny: true` - Error on implicit any
- `strictNullChecks: true` - Strict null handling
- `noUnusedLocals: true` - Error on unused variables

### Module Resolution

```json
{
  "module": "ESNext",
  "moduleResolution": "bundler"
}
```

Use "bundler" resolution for modern bundlers (Vite, esbuild).
Use "NodeNext" for pure Node.js without bundler.

### Path Aliases

```json
{
  "paths": {
    "@/*": ["./src/*"],
    "@shared/*": ["./shared/*"]
  }
}
```

Requires bundler configuration (e.g., Vite's `resolve.alias`).

## Variations

### Node.js Backend Only

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

### React Frontend

Add to compilerOptions:
```json
{
  "jsx": "react-jsx",
  "lib": ["ES2022", "DOM", "DOM.Iterable"]
}
```

### Monorepo (Extend Base)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```
