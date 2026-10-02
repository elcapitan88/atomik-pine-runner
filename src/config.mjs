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
  // Live chart indicators: DataHub trades -> bars -> PineTS -> Redis strategy_state.
  // All three must be set for the live manager to start.
  datahubWsUrl: env.DATAHUB_WS_URL || '',          // ws://atomik-datahub.internal:8000/ws
  datahubApiKey: env.DATAHUB_API_KEY || '',
  redisUrl: env.REDIS_URL || '',
  backendInternalUrl: env.BACKEND_INTERNAL_URL || 'http://atomik-backend.internal:8000',
  liveEnabled: (env.PINE_LIVE_ENABLED || 'true') === 'true',
  liveWarmupBars: int('PINE_LIVE_WARMUP_BARS', 5000),
  // Intrabar: re-run on the forming bar while trades arrive, at most every N
  // seconds per session (stretched automatically when a script runs slowly).
  // Every re-run is a full recompute; on a shared-CPU machine a tight cadence
  // burns the burst budget and slows every run down, so the default is loose.
  liveIntrabarSeconds: int('PINE_LIVE_INTRABAR_SECONDS', 5),
  // Streaming: each live session's script stays open in a dedicated stream
  // worker and an update re-executes only the last bar or two. Off = every
  // update is a full re-run (the settings above).
  liveStreaming: (env.PINE_LIVE_STREAMING || 'true') === 'true',
  streamWorkers: int('PINE_STREAM_WORKERS', 1),
  // Each open stream holds an isolate (~40MB RSS at 5,000 bars); beyond this, sessions
  // fall back to full re-runs.
  maxStreams: int('PINE_MAX_STREAMS', 8),
  // Forming-bar cadence for streamed sessions (an update costs milliseconds).
  liveStreamIntrabarMs: int('PINE_LIVE_STREAM_INTRABAR_MS', 1000),
  // Reopen a stream from history once it has grown this many bars past the
  // warmup, so its memory stays bounded.
  liveStreamRecycleBars: int('PINE_LIVE_STREAM_RECYCLE_BARS', 2000),
  liveSyncSeconds: int('PINE_LIVE_SYNC_SECONDS', 30),
  liveRunTimeoutMs: int('PINE_LIVE_RUN_TIMEOUT_MS', 20_000),
  // Re-publish unchanged state this often so a chart opened between bar closes
  // catches up even when its own catch-up request is lost.
  liveHeartbeatSeconds: int('PINE_LIVE_HEARTBEAT_SECONDS', 60),
  // Rich drawings: box/line/label objects go to the chart with their full
  // style (colors, borders, any-angle lines, text at the point) instead of
  // plain teal boxes plus price levels. OFF until a frontend that draws them
  // is live: older charts would draw the new kinds as teal rectangles.
  richDrawings: env.PINE_RICH_DRAWINGS === 'true',
  // Newest objects of each kind sent per frame (TradingView allows 500).
  maxDrawings: int('PINE_MAX_DRAWINGS', 300),
  // Trading: send signals for activated Pine strategies to the backend's
  // /api/v1/trades/execute. OFF unless explicitly enabled; the key is the
  // strategy engine's (the same one DataHub accepts).
  tradingEnabled: env.PINE_TRADING_ENABLED === 'true',
  executionApiKey: env.EXECUTION_API_KEY || env.DATAHUB_API_KEY || '',
  get isProduction() {
    return this.environment === 'production';
  },
};
