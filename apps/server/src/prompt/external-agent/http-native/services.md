# Using Huabu Services

Use a Service Package when the task needs a configured provider. Huabu exposes discovery, credential-free Package guidance and downloads separately from private point-in-time configuration leases. This is not a generic provider proxy.

## Discover and inspect

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/services"
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/services/image-gen/manifest"
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/services/image-gen/skill"
```

Select only a Service with `availableToExternalAgent: true`. Read its Skill and use the provider documentation it links. Manifest and Skill responses contain no credentials.

## Download and use a Package

```bash
curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/download/services/image-gen.zip" \
  -o image-gen.zip
unzip image-gen.zip
cd image-gen
```

Read `SKILL.md`. With compatible Node, run `node entry.mjs --help` before invoking an optional entry because live help reflects the leased Manifest and configured defaults. Huabu provides the entry and `HUABU_SERVICE_SDK_URL`, not Node. The entry is a modifiable starting point, not a complete provider SDK; extend only a local Package copy and follow the official provider documentation.

## Lease configuration in a custom process

When the entry cannot perform the required operation, write a business subprocess in an available language. Inside that process, send authenticated `POST /services/<id>/lease` using inherited `HUABU_RFS_TOKEN`, never argv. Reject non-2xx responses and require one coherent `{ id, version, manifest, config }` result whose IDs and versions agree.

This Python example keeps the lease inside the process; replace `perform_provider_operation` with the provider request described by the Package Skill:

```python
import json
import os
import urllib.request

service_id = "image-gen"
request = urllib.request.Request(
    f"{os.environ['HUABU_RFS_URL']}/services/{service_id}/lease",
    method="POST",
    headers={"Authorization": f"Bearer {os.environ['HUABU_RFS_TOKEN']}"},
)
with urllib.request.urlopen(request) as response:
    lease = json.load(response)

if (
    lease.get("id") != service_id
    or lease.get("manifest", {}).get("id") != service_id
    or lease.get("manifest", {}).get("version") != lease.get("version")
):
    raise RuntimeError("Invalid Service lease")

result = perform_provider_operation(lease["manifest"], lease["config"])
emit_business_result(result)
```

With compatible Node, the Huabu-owned SDK performs the same lease step:

```js
const { withServiceContext } = await import(process.env.HUABU_SERVICE_SDK_URL);
const result = await withServiceContext('image-gen', async (lease) => {
  return performProviderOperation(lease.manifest, lease.config);
});
```

Consume credentials only in memory and send them only to the intended provider. Do not print or persist the lease, provider headers or credentials, place them in argv/global shell environment, or expose them through diagnostics. A lease is a point-in-time snapshot, not a subscription or retry guarantee. After an ambiguous provider mutation failure, inspect provider state before deciding whether another operation is safe.
