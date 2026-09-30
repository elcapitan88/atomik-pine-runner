// Runtime configuration, all from the environment. Nothing here is secret
// except TIMESCALE_URL and PINE_RUNNER_KEY, and neither ever reaches an isolate.
const env = process.env;

const int = (name, fallback) => {
  const v = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
};

export const config = {
  port: int('PORT', 8000),
  host: env.HOST || '0.0.0.0',
  environment: env.ENVIRONMENT || 'development',
  // Shared secret the backend presents as X-API-Key. Required in production.
  serviceKey: env.PINE_RUNNER_KEY || '',
  // Read-only connection to the TimescaleDB bar warehouse.
  timescaleUrl: env.TIMESCALE_URL || '',
  // Sandbox limits.
  workerCount: int('PINE_WORKERS', 2),
  isolateMemoryMb: int('PINE_ISOLATE_MEMORY_MB', 256),
  compileTimeoutMs: int('PINE_COMPILE_TIMEOUT_MS', 15_000),
  backtestTimeoutMs: int('PINE_BACKTEST_TIMEOUT_MS', 90_000),
  compileBars: int('PINE_COMPILE_BARS', 500),
  maxBars: int('PINE_MAX_BARS', 400_000),
  maxSourceBytes: int('PINE_MAX_SOURCE_BYTES', 200_000),
  maxPlotPoints: int('PINE_MAX_PLOT_POINTS', 3000),
  // Symbol + timeframe used by /v1/compile when the caller names none.
  compileSymbol: env.PINE_COMPILE_SYMBOL || 'NQ',
  compileTimeframe: env.PINE_COMPILE_TIMEFRAME || '5m',
  get isProduction() {
    return this.environment === 'production';
  },
};
