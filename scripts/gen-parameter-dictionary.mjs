// Generate docs/PARAMETERS.md from the parameter registry (single source of truth).
import { createServer } from 'vite';
import { writeFile, mkdir } from 'node:fs/promises';
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const reg = await server.ssrLoadModule('/src/data/registry.ts');
  const { SOURCE_CLASS_LABEL } = await server.ssrLoadModule('/src/physics/provenance.ts');
  const lines = [
    '# Parameter dictionary',
    '',
    'Generated from `src/data/registry.ts` by `npm run docs:params`. Internal values are SI; the display unit is what the interface shows.',
    'Every parameter is a build-time cause (locked during a run). Derived consequences are listed separately and are never editable.',
    '',
  ];
  const groups = [...new Set(reg.PARAMS.map((p) => p.group))];
  for (const g of groups) {
    lines.push(`## ${g[0].toUpperCase()}${g.slice(1)}`, '');
    lines.push('| Parameter | Symbol | Path | SI unit | Display | Range | Tier | Class | Description |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const p of reg.PARAMS.filter((x) => x.group === g)) {
      const range = p.kind === 'number' ? `${p.min ?? ''} – ${p.max ?? ''}${p.scale === 'log' ? ' (log)' : ''}` : p.kind === 'select' ? p.options.map((o) => '`' + o.value + '`').join(', ') : 'on/off';
      lines.push(`| ${p.name} | ${p.symbol} | \`${p.path}\` | ${p.unit.si} | ${p.unit.display || '—'} | ${range} | ${p.tier} | ${SOURCE_CLASS_LABEL[p.classification]} | ${p.tooltip.replace(/\|/g, '\\|')}${p.dependsOn.length ? ` Constrained by: ${p.dependsOn.map((d) => '`' + d + '`').join(', ')}.` : ''} |`);
    }
    lines.push('');
  }
  lines.push('## Derived consequences (not editable)', '', '| Quantity | Symbol | Unit | Model | Formula | Class |', '|---|---|---|---|---|---|');
  for (const d of reg.DERIVED_QUANTITIES) lines.push(`| ${d.name} | ${d.symbol} | ${d.unit} | ${d.model} | ${d.formula.replace(/\|/g, '\\|')} | ${SOURCE_CLASS_LABEL[d.classification]} |`);
  await mkdir('docs', { recursive: true });
  await writeFile('docs/PARAMETERS.md', lines.join('\n') + '\n');
  console.log(`docs/PARAMETERS.md written (${reg.PARAMS.length} parameters, ${reg.DERIVED_QUANTITIES.length} derived quantities)`);
} finally {
  await server.close();
}
