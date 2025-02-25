import { describe, expect, it } from "bun:test";
import Router, { type HandlerFunc } from "./router";

const TEST_HANDLER: HandlerFunc = () => "";

describe("router", () => {
  describe("basic routing", () => {
    it("basic", () => {
      const router = new Router();
      router.get("/", TEST_HANDLER);
      expect(router.find("GET", "/").handler).toBeDefined();
    });
  });

  describe("routes w/ params", () => {
    it("single param", () => {
      const router = new Router();
      router.get("/route/:id", TEST_HANDLER);

      expect(router.find("GET", "/route/12398").handler).toBeDefined();
      expect(router.find("GET", "/route").handler).toBeUndefined();
      expect(router.find("GET", "/route/12398/asdf").handler).toBeUndefined();
    });

    it("multi param", () => {
      const router = new Router();
      router.get("/route/:id/test/:name", TEST_HANDLER);

      const { handler, params } = router.find("GET", "/route/12398/test/asdf");
      expect(handler).toBeDefined();
      expect(params["id"]).toBe("12398");
      expect(params["name"]).toBe("asdf");
    });
  });
});
