import { useEffect, useState } from 'react';
import type { ParamDef } from '../../data/registry';
import { fromDisplay, toDisplay } from '../../data/registry';
import { SOURCE_CLASS_LABEL, SOURCE_CLASS_SHORT, type SourceClass } from '../../physics/provenance';
import type { BuildIssue } from '../../sim/build';

const BADGE_CLASS: Record<SourceClass, string> = {
  'physical-law': 'law',
  'published-reference': 'ref',
  'engineering-approximation': 'approx',
  'fictional-game-hardware': 'game',
};

export function SourceBadge({ cls }: { cls: SourceClass }) {
  return (
    <span className={`badge ${BADGE_CLASS[cls]}`} title={SOURCE_CLASS_LABEL[cls]} aria-label={SOURCE_CLASS_LABEL[cls]}>
      {SOURCE_CLASS_SHORT[cls]}
    </span>
  );
}

interface Props {
  def: ParamDef;
  value: unknown;
  onChange: (v: unknown) => void;
  locked: boolean;
  issues: BuildIssue[];
  consequence?: string;
  onInspect?: () => void;
}

function sliderPos(def: ParamDef, si: number): number {
  const lo = def.min ?? 0, hi = def.max ?? 1;
  if (def.scale === 'log' && lo > 0) return (Math.log(si) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return (si - lo) / (hi - lo);
}
function sliderValue(def: ParamDef, f: number): number {
  const lo = def.min ?? 0, hi = def.max ?? 1;
  if (def.scale === 'log' && lo > 0) return Math.exp(Math.log(lo) + f * (Math.log(hi) - Math.log(lo)));
  return lo + f * (hi - lo);
}

export function ParamControl({ def, value, onChange, locked, issues, consequence, onInspect }: Props) {
  const id = `p-${def.path.replace(/\./g, '-')}`;
  const err = issues.find((i) => i.level === 'error');
  const warnI = issues.find((i) => i.level === 'warning');
  const tip = `${def.tooltip}\n\nPath: ${def.path}\nSI unit: ${def.unit.si}${def.min !== undefined ? `\nAllowed: ${def.min} – ${def.max} ${def.unit.si}` : ''}\n${SOURCE_CLASS_LABEL[def.classification]}`;
  return (
    <div className={`param${err ? ' invalid' : ''}`}>
      <div className="row1">
        <label htmlFor={id} className="name" title={tip}>
          {def.name}
        </label>
        {def.symbol !== '—' && <span className="sym">{def.symbol}</span>}
        <SourceBadge cls={def.classification} />
        {onInspect && (
          <button className="inspect" onClick={onInspect} title="Inspect formula, source and assumptions" aria-label={`Inspect model for ${def.name}`}>
            ⓘ
          </button>
        )}
      </div>
      <div className="row2">
        {def.kind === 'number' && <NumberInput id={id} def={def} value={value as number} onChange={onChange} locked={locked} />}
        {def.kind === 'select' && (
          <select id={id} value={String(value)} disabled={locked} onChange={(e) => onChange(e.target.value)}>
            {def.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {def.kind === 'boolean' && (
          <label className="toggle">
            <input id={id} type="checkbox" checked={Boolean(value)} disabled={locked} onChange={(e) => onChange(e.target.checked)} />
            <span>{value ? 'On' : 'Off'}</span>
          </label>
        )}
      </div>
      {consequence && <div className="consequence">→ {consequence}</div>}
      {err && <div className="issue" role="alert">✖ {err.message}</div>}
      {!err && warnI && <div className="issue warn">▲ {warnI.message}</div>}
    </div>
  );
}

function NumberInput({ id, def, value, onChange, locked }: { id: string; def: ParamDef; value: number; onChange: (v: unknown) => void; locked: boolean }) {
  const disp = toDisplay(def, value);
  const prec = def.precision ?? 2;
  const fmt = (d: number): string => (Math.abs(d) > 0 && (Math.abs(d) < 10 ** -Math.min(prec, 4) || Math.abs(d) >= 1e7) ? d.toExponential(2) : d.toFixed(Math.min(prec, 6)));
  const [text, setText] = useState(fmt(disp));
  useEffect(() => setText(fmt(disp)), [disp]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (t: string): void => {
    const d = Number(t);
    if (!Number.isFinite(d)) {
      setText(fmt(disp));
      return;
    }
    onChange(fromDisplay(def, d));
  };
  const pos = Number.isFinite(value) ? Math.min(1, Math.max(0, sliderPos(def, value))) : 0;
  return (
    <>
      {def.min !== undefined && def.max !== undefined && (
        <input
          type="range"
          aria-label={`${def.name} slider`}
          min={0}
          max={1000}
          step={1}
          value={Math.round(pos * 1000)}
          disabled={locked}
          onChange={(e) => {
            let v = sliderValue(def, Number(e.target.value) / 1000);
            const d = toDisplay(def, v);
            const r = Math.pow(10, -(def.scale === 'log' ? Math.max(prec, 3) : prec));
            v = fromDisplay(def, Math.round(d / r) * r);
            onChange(v);
          }}
        />
      )}
      <span className="numbox">
        <input
          id={id}
          inputMode="decimal"
          value={text}
          disabled={locked}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          }}
          aria-describedby={`${id}-unit`}
        />
        <span className="unit" id={`${id}-unit`}>
          {def.unit.display || '—'}
        </span>
      </span>
    </>
  );
}
