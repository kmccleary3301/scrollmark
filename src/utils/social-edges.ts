import { SocialEdge, User, UserRelationshipFields } from '@/types';

export function buildRelationshipFields(edges: SocialEdge[]): UserRelationshipFields {
  const relationTypes = Array.from(new Set(edges.map((edge) => edge.relation_type))).sort();
  const subjectUserIds = Array.from(new Set(edges.map((edge) => edge.subject_user_id))).sort();
  const subjectScreenNames = Array.from(
    new Set(edges.map((edge) => String(edge.subject_screen_name || '').trim()).filter(Boolean)),
  ).sort();
  const lastObservedAt = Math.max(...edges.map((edge) => Number(edge.observed_at) || 0), 0);

  return {
    relation_types: relationTypes,
    subject_user_ids: subjectUserIds,
    subject_screen_names: subjectScreenNames,
    last_observed_at: lastObservedAt,
    edge_count: edges.length,
  };
}

export function enrichUsersWithRelationshipFields(users: User[], edges: SocialEdge[]): User[] {
  if (!users.length || !edges.length) {
    return users;
  }

  const edgeMap = new Map<string, SocialEdge[]>();
  for (const edge of edges) {
    const key = String(edge.related_user_id || '').trim();
    if (!key) continue;
    const bucket = edgeMap.get(key);
    if (bucket) {
      bucket.push(edge);
    } else {
      edgeMap.set(key, [edge]);
    }
  }

  return users.map((user) => {
    const relatedEdges = edgeMap.get(String(user.rest_id || '').trim());
    if (!relatedEdges?.length) {
      return user;
    }

    return {
      ...user,
      twe_relationship_fields: buildRelationshipFields(relatedEdges),
    };
  });
}
