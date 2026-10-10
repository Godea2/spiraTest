import { applyEndpointChanges, toEndpointsStatus } from "@/lib/server/endpoint-overrides";
import { handler, ok, parseBody } from "@/lib/server/http";
import { readOverrides, writeOverrides } from "@/lib/server/overrides-cookie";
import { endpointsUpdateSchema } from "@/lib/server/schemas";

export const GET = handler(async () => ok(toEndpointsStatus(await readOverrides())));

export const PUT = handler(async (request: Request) => {
  const changes = await parseBody(request, endpointsUpdateSchema);
  const next = applyEndpointChanges(await readOverrides(), changes);
  await writeOverrides(next);
  return ok(toEndpointsStatus(next));
});
