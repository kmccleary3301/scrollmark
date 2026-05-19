export type SocialRelationType = 'follower' | 'following' | 'subscription';

export interface SocialEdge {
  id: string;
  extension: string;
  relation_type: SocialRelationType;
  subject_user_id: string;
  subject_screen_name?: string;
  related_user_id: string;
  related_screen_name?: string;
  observed_at: number;
  provenance_surface?: string;
}

export interface UserRelationshipFields {
  relation_types: SocialRelationType[];
  subject_user_ids: string[];
  subject_screen_names: string[];
  last_observed_at: number;
  edge_count: number;
}
