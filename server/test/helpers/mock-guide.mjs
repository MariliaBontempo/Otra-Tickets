export const TOKEN = "jwt.access.token";

// Returns a restore function; `restore.calls` counts requests sent to the Guide.
export function mockGuide({ tokenOk = true, roleStatus = 200, isStaff = false, down = false, tokenStatus = 0 } = {}) {
  const original = globalThis.fetch;
  const restore = () => { globalThis.fetch = original; };
  restore.calls = 0;
  globalThis.fetch = async (input) => {
    restore.calls += 1;
    if (down) throw new Error("network");
    const path = new URL(input).pathname;
    if (path === "/api/auth/token/") {
      if (tokenStatus) return new Response("{}", { status: tokenStatus });
      return tokenOk ? Response.json({ access: TOKEN, refresh: "r" }) : new Response("{}", { status: 401 });
    }
    if (path === "/api/users/user-role/") {
      return roleStatus === 200 ? Response.json({ is_staff_or_admin: isStaff }) : new Response("{}", { status: roleStatus });
    }
    if (path === "/api/users/profile/") return Response.json({ first_name: "Ana", last_name: "Silva", email: "ana@x.com" });
    throw new Error(`Unexpected request: ${path}`);
  };
  return restore;
}
