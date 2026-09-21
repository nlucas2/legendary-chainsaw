import test from "node:test";
import assert from "node:assert/strict";
import { isTunnelAuthentication } from "../src/lib/authentication.ts";

test("only a tunnel authentication challenge selects gateway sign-in, not the daemon token form", () => {
  for (const challenge of ["tunnel", "Tunnel", "tunnel realm=\"example\"", "Bearer, tunnel"]) {
    assert.equal(isTunnelAuthentication(401, challenge), true);
  }
  for (const challenge of [null, "", "Bearer", "Basic realm=\"tunnel\"", "tunnel-other"]) {
    assert.equal(isTunnelAuthentication(401, challenge), false);
  }
  for (const status of [200, 403, 500]) assert.equal(isTunnelAuthentication(status, "tunnel"), false);
});
