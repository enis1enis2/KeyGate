import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// KeyGate load/soak profile.
//
//   SCENARIO=smoke|load|ratelimit|soak
//   BASE_URL       default http://127.0.0.1:3000
//   ADMIN_TOKEN    enables the management endpoint checks
//   GATEWAY_KEY    enables the data-plane /v1/models check
//
// The gateway has a deliberate global rate limit (RATE_LIMIT_MAX, default 300/min)
// and a data-plane limit (RATE_LIMIT_V1_MAX, default 120/min). A 429 is therefore
// a *correct* response under load. This script accepts 429 as expected and fails
// only on 4xx auth/validation errors, 5xx, or transport errors. To measure raw
// throughput instead of the limiter, run a disposable instance with the limits
// raised, e.g. `-e RATE_LIMIT_MAX=100000 -e RATE_LIMIT_V1_MAX=100000`, then run
// the `ratelimit` scenario against the default limits to prove the limiter works.
//
// Run it with Docker so nothing has to be installed:
//   docker run --rm --network host -e BASE_URL=http://127.0.0.1:3000 \
//     -e ADMIN_TOKEN=... -e GATEWAY_KEY=... -e SCENARIO=soak \
//     -v "$PWD/load-tests:/scripts" grafana/k6:latest run /scripts/keygate.js

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
const GATEWAY_KEY = __ENV.GATEWAY_KEY || '';
const SCENARIO = __ENV.SCENARIO || 'smoke';

const scenarios = {
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '15s',
  },
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 10 },
      { duration: '2m', target: 10 },
      { duration: '20s', target: 0 },
    ],
    gracefulRampDown: '10s',
  },
  ratelimit: {
    executor: 'constant-arrival-rate',
    rate: 100,
    timeUnit: '1s',
    duration: '20s',
    preAllocatedVUs: 20,
    maxVUs: 60,
  },
  soak: {
    executor: 'constant-vus',
    vus: 5,
    duration: '10m',
  },
};

const thresholds = {
  http_req_failed: ['rate<0.02'],
  http_req_duration: ['p(95)<1000'],
  checks: ['rate>0.98'],
  server_errors: ['rate<0.001'],
};

// Only the ratelimit scenario asserts that the limiter actually engages.
if (SCENARIO === 'ratelimit') {
  thresholds.rate_limited = ['rate>0.5'];
}

export const options = {
  scenarios: { [SCENARIO]: scenarios[SCENARIO] || scenarios.smoke },
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// A 429 is an expected answer under load; anything else non-2xx is not.
http.setResponseCallback(http.expectedStatuses(200, 429));

const authFailures = new Rate('auth_failures');
const serverErrors = new Rate('server_errors');
const rateLimited = new Rate('rate_limited');

function record(response) {
  serverErrors.add(response.status >= 500);
  rateLimited.add(response.status === 429);
}

export default function () {
  const health = http.get(`${BASE_URL}/healthz`, { tags: { endpoint: 'healthz' } });
  record(health);
  check(health, {
    'healthz answers 200 or 429': (r) => r.status === 200 || r.status === 429,
    'healthz reports database ok when served': (r) => {
      if (r.status !== 200) return true;
      try {
        return JSON.parse(r.body).database === 'ok';
      } catch {
        return false;
      }
    },
  });

  if (ADMIN_TOKEN) {
    const stats = http.get(`${BASE_URL}/api/dashboard/stats`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      tags: { endpoint: 'admin_stats' },
    });
    record(stats);
    check(stats, {
      'stats is served or rate limited': (r) => r.status === 200 || r.status === 429,
      'stats is never unauthorized': (r) => r.status !== 401 && r.status !== 403,
    });
    authFailures.add(stats.status === 401 || stats.status === 403);
  }

  if (GATEWAY_KEY) {
    const models = http.get(`${BASE_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${GATEWAY_KEY}` },
      tags: { endpoint: 'v1_models' },
    });
    record(models);
    check(models, {
      'models is served or rate limited': (r) => r.status === 200 || r.status === 429,
      'models is never unauthorized': (r) => r.status !== 401 && r.status !== 403,
    });
    authFailures.add(models.status === 401 || models.status === 403);
  }

  if (SCENARIO !== 'ratelimit') {
    sleep(0.5);
  }
}
