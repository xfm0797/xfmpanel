/**
 * 轻量 SVG 折线/面积图（零依赖，无需 canvas 与构建）。
 *
 * 为什么不用图表库：面板是"零三方依赖"的交付形态，仪表盘只需要 4 条时间序列，
 * 手写 60 行 SVG 比引入 200KB 的库更合适；同时也避免了 CSP 下的额外脚本来源。
 */

let seq = 0;

/** 把峰值向上取整到 1/2/5 × 10^n，让网络图表的 Y 轴刻度稳定 */
export function niceMax(value) {
  const n = Math.max(1, Number(value) || 1);
  const exp = Math.floor(Math.log10(n));
  const base = 10 ** exp;
  const m = n / base;
  const mult = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return mult * base;
}

/**
 * @param {Array<{values:number[], color:string, fill?:boolean, dashed?:boolean}>} sets
 * @param {{max?:number,min?:number,height?:number,grid?:boolean}} opts
 * @returns {string} SVG 字符串
 */
export function chart(sets, { max = 100, min = 0, height = 56, width = 240, grid = true } = {}) {
  const valid = (sets || []).filter((s) => Array.isArray(s.values) && s.values.length >= 2);
  if (!valid.length) return '<div class="chart-empty">正在采集数据…</div>';

  const pad = 4;
  const n = Math.max(...valid.map((s) => s.values.length));
  const span = Math.max(1, max - min);
  const stepX = n > 1 ? (width - pad * 2) / (n - 1) : 0;

  const toCoords = (values) => {
    const offset = n - values.length; // 长度不足时右对齐，最新点始终贴右边
    return values.map((v, i) => {
      const ratio = (Math.min(max, Math.max(min, Number(v) || 0)) - min) / span;
      return [pad + (offset + i) * stepX, height - pad - ratio * (height - pad * 2)];
    });
  };

  const gridLines = grid
    ? [0.25, 0.5, 0.75].map((r) => {
      const y = (height - pad - r * (height - pad * 2)).toFixed(1);
      return `<line x1="0" x2="${width}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"
        style="stroke:var(--border);stroke-width:1;stroke-dasharray:2 5" opacity=".75" />`;
    }).join('')
    : '';

  const shapes = valid.map((s) => {
    const color = s.color || 'var(--accent)';
    const pts = toCoords(s.values);
    const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const gid = `xfc-${++seq}`;
    const area = s.fill === false
      ? ''
      : `<defs>
           <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
             <stop offset="0" style="stop-color:${color};stop-opacity:.28" />
             <stop offset="1" style="stop-color:${color};stop-opacity:0" />
           </linearGradient>
         </defs>
         <path d="${line} L${(pts[pts.length - 1][0]).toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z"
           style="fill:url(#${gid})" />`;
    return `${area}
      <path d="${line}" vector-effect="non-scaling-stroke"
        style="fill:none;stroke:${color};stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round"
        ${s.dashed ? 'stroke-dasharray="3 3"' : ''} />`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" height="${height}" aria-hidden="true">
    ${gridLines}
    ${shapes}
    <line x1="${width - 0.5}" x2="${width - 0.5}" y1="${pad}" y2="${height - pad}"
      vector-effect="non-scaling-stroke" style="stroke:var(--border-strong);stroke-width:1" />
  </svg>`;
}
