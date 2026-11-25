import { test } from "node:test";
import assert from "node:assert/strict";
import { header, predict, schedule, short, type Expected } from "../web/src/predict.ts";

const at = (y: number, m: number, d: number, h = 8, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const rel = (...ts: number[]) => ts.map((t): [number, string | null] => [t, null]);

test("next-episode prediction agrees with the app's rules", () => {
  const weekly = predict(rel(at(2026, 10, 24), at(2026, 10, 31), at(2026, 11, 7), at(2026, 11, 14), at(2026, 11, 21))) as Expected;
  assert.equal(weekly.at, at(2026, 11, 28)); assert.equal(weekly.confidence, "high"); assert.equal(schedule(weekly), "usually weekly on Saturdays");
  // ATP: only 3 of 5 share a weekday, so latest + 7 days at the median time.
  const atp = predict(rel(at(2026, 10, 23, 19, 32), at(2026, 10, 29, 21, 30), at(2026, 11, 5, 21, 10), at(2026, 11, 12, 20, 50), at(2026, 11, 20, 21, 7))) as Expected;
  assert.equal(atp.at, at(2026, 11, 27, 21, 7)); assert.equal(atp.weekday, null);
  const weekdays = predict(rel(at(2026, 11, 16), at(2026, 11, 17), at(2026, 11, 18), at(2026, 11, 19), at(2026, 11, 20))) as Expected;
  assert.equal(weekdays.at, at(2026, 11, 23)); assert.equal(schedule(weekdays), "usually every weekday");
  assert.deepEqual(predict(rel(at(2026, 11, 1), at(2026, 11, 8))), { irregular: "few" });
  assert.deepEqual(predict([[at(2026, 11, 1), "trailer"], [at(2026, 11, 8), "bonus"], [at(2026, 11, 9), null]]), { irregular: "few" });
  assert.deepEqual(predict(rel(at(2026, 1, 1), at(2026, 1, 2), at(2026, 3, 1), at(2026, 3, 3), at(2026, 8, 1))), { irregular: "uneven" });
  assert.equal(short(weekly, at(2026, 11, 30, 9)).text, "Overdue by 2 days"); assert.match(header(weekly, at(2026, 11, 22)).head, /^Next episode expected Sat 28 Nov, ~08:00$/);
});
