import registry from './surface-policy-registry.v1.json';

type PolicyClass = 'public' | 'sensitive' | 'dm';

interface PolicyRegistryShape {
  route_policies?: Record<string, string>;
}

const policyRegistry = registry as PolicyRegistryShape;

function normalizeRouteType(routeType: string): string {
  const next = String(routeType || '').trim();
  return next || 'unknown';
}

export function getPolicyClass(routeType: string): PolicyClass {
  const normalized = normalizeRouteType(routeType);
  const raw =
    policyRegistry.route_policies?.[normalized] ||
    policyRegistry.route_policies?.unknown ||
    'public';
  if (raw === 'dm' || raw === 'sensitive' || raw === 'public') {
    return raw;
  }
  return 'public';
}

export function shouldCaptureByPolicy(
  routeType: string,
  opts: { dmCaptureAllowed: boolean },
): boolean {
  const cls = getPolicyClass(routeType);
  if (cls === 'dm') {
    return !!opts.dmCaptureAllowed;
  }
  return true;
}
