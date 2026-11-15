export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: { extensions?: Json; operationName?: string; query?: string; variables?: Json };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      analytics_events: {
        Row: {
          created_at: string;
          dedup_key: string;
          event: string;
          game_day: string;
          id: number;
          occurred_at: string;
          props: NonNullable<Json>;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          dedup_key: string;
          event: string;
          game_day: string;
          id?: never;
          occurred_at: string;
          props?: NonNullable<Json>;
          user_id: string;
        };
        Update: {
          created_at?: string;
          dedup_key?: string;
          event?: string;
          game_day?: string;
          id?: never;
          occurred_at?: string;
          props?: NonNullable<Json>;
          user_id?: string;
        };
        Relationships: [];
      };
      claimed_cells: {
        Row: {
          cell: number;
          first_claimed_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          cell: number;
          first_claimed_at: string;
          user_id: string;
        };
        Update: {
          cell?: number;
          first_claimed_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      detour_days: {
        Row: {
          game_day: string;
          generated_at: string;
          source: string | null;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          game_day: string;
          generated_at: string;
          source?: string | null;
          updated_at: string;
          user_id: string;
        };
        Update: {
          game_day?: string;
          generated_at?: string;
          source?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      detour_offers: {
        Row: {
          added_m: number;
          added_min: number;
          anchor: unknown;
          band: string;
          collected_at: string | null;
          collected_ref: string | null;
          created_at: string;
          game_day: string;
          geom: unknown;
          id: number;
          name: string | null;
          off_route_m: number;
          reward: NonNullable<Json>;
          reward_kind: string;
          slot: number;
          spot_id: number;
          spot_kind: string;
          spot_subtype: string | null;
          user_id: string;
          valid_from: string;
          valid_until: string;
          xp: number;
        };
        ComputedFields: never;
        Insert: {
          added_m: number;
          added_min: number;
          anchor: unknown;
          band: string;
          collected_at?: string | null;
          collected_ref?: string | null;
          created_at: string;
          game_day: string;
          geom: unknown;
          id?: never;
          name?: string | null;
          off_route_m: number;
          reward: NonNullable<Json>;
          reward_kind: string;
          slot: number;
          spot_id: number;
          spot_kind: string;
          spot_subtype?: string | null;
          user_id: string;
          valid_from: string;
          valid_until: string;
          xp: number;
        };
        Update: {
          added_m?: number;
          added_min?: number;
          anchor?: unknown;
          band?: string;
          collected_at?: string | null;
          collected_ref?: string | null;
          created_at?: string;
          game_day?: string;
          geom?: unknown;
          id?: never;
          name?: string | null;
          off_route_m?: number;
          reward?: NonNullable<Json>;
          reward_kind?: string;
          slot?: number;
          spot_id?: number;
          spot_kind?: string;
          spot_subtype?: string | null;
          user_id?: string;
          valid_from?: string;
          valid_until?: string;
          xp?: number;
        };
        Relationships: [];
      };
      detour_spot_areas: {
        Row: {
          area: number;
          failed_at: string | null;
          fetched_at: string | null;
          last_error: string | null;
          lease_until: string | null;
          spot_count: number;
        };
        ComputedFields: never;
        Insert: {
          area: number;
          failed_at?: string | null;
          fetched_at?: string | null;
          last_error?: string | null;
          lease_until?: string | null;
          spot_count?: number;
        };
        Update: {
          area?: number;
          failed_at?: string | null;
          fetched_at?: string | null;
          last_error?: string | null;
          lease_until?: string | null;
          spot_count?: number;
        };
        Relationships: [];
      };
      detour_spots: {
        Row: {
          area: number;
          geom: unknown;
          id: number;
          kind: string;
          name: string | null;
          subtype: string | null;
        };
        ComputedFields: never;
        Insert: {
          area: number;
          geom: unknown;
          id: number;
          kind: string;
          name?: string | null;
          subtype?: string | null;
        };
        Update: {
          area?: number;
          geom?: unknown;
          id?: number;
          kind?: string;
          name?: string | null;
          subtype?: string | null;
        };
        Relationships: [];
      };
      economy_days: {
        Row: {
          game_day: string;
          new_ground_km: number;
          new_ground_xp: number;
          user_id: string;
          usual_km: number;
          usual_paid_km: number;
          usual_xp: number;
        };
        ComputedFields: never;
        Insert: {
          game_day: string;
          new_ground_km?: number;
          new_ground_xp?: number;
          user_id: string;
          usual_km?: number;
          usual_paid_km?: number;
          usual_xp?: number;
        };
        Update: {
          game_day?: string;
          new_ground_km?: number;
          new_ground_xp?: number;
          user_id?: string;
          usual_km?: number;
          usual_paid_km?: number;
          usual_xp?: number;
        };
        Relationships: [];
      };
      economy_ledger: {
        Row: {
          created_at: string;
          crystal: number;
          details: Json | null;
          gems: number;
          gold: number;
          id: number;
          reason: string;
          ref: string | null;
          stone: number;
          tickets: number;
          user_id: string;
          wood: number;
          xp: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          crystal?: number;
          details?: Json | null;
          gems?: number;
          gold?: number;
          id?: never;
          reason: string;
          ref?: string | null;
          stone?: number;
          tickets?: number;
          user_id: string;
          wood?: number;
          xp?: number;
        };
        Update: {
          created_at?: string;
          crystal?: number;
          details?: Json | null;
          gems?: number;
          gold?: number;
          id?: never;
          reason?: string;
          ref?: string | null;
          stone?: number;
          tickets?: number;
          user_id?: string;
          wood?: number;
          xp?: number;
        };
        Relationships: [];
      };
      kingdom_actions: {
        Row: {
          batches: Json | null;
          building: string | null;
          count: number | null;
          created_at: string;
          game_day: string;
          id: number;
          kind: string;
          level: number | null;
          request_id: string;
          result: NonNullable<Json>;
          unit: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          batches?: Json | null;
          building?: string | null;
          count?: number | null;
          created_at?: string;
          game_day: string;
          id?: never;
          kind: string;
          level?: number | null;
          request_id: string;
          result: NonNullable<Json>;
          unit?: string | null;
          user_id: string;
        };
        Update: {
          batches?: Json | null;
          building?: string | null;
          count?: number | null;
          created_at?: string;
          game_day?: string;
          id?: never;
          kind?: string;
          level?: number | null;
          request_id?: string;
          result?: NonNullable<Json>;
          unit?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      location_batches: {
        Row: {
          accepted_points: number;
          batch_id: string;
          created_at: string;
          new_cells: number;
          received_points: number;
          rejected_points: number;
          session_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          accepted_points?: number;
          batch_id: string;
          created_at?: string;
          new_cells?: number;
          received_points: number;
          rejected_points?: number;
          session_id: string;
          user_id: string;
        };
        Update: {
          accepted_points?: number;
          batch_id?: string;
          created_at?: string;
          new_cells?: number;
          received_points?: number;
          rejected_points?: number;
          session_id?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      player_buildings: {
        Row: {
          building: string;
          level: number;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          building: string;
          level: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          building?: string;
          level?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      player_economy: {
        Row: {
          created_at: string;
          crystal: number;
          gems: number;
          gold: number;
          keep_tax_paid_through: string | null;
          ruler_xp: number;
          stone: number;
          time_zone: string;
          time_zone_set_at: string | null;
          trade_tickets: number;
          updated_at: string;
          user_id: string;
          wood: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          crystal: number;
          gems: number;
          gold: number;
          keep_tax_paid_through?: string | null;
          ruler_xp?: number;
          stone: number;
          time_zone?: string;
          time_zone_set_at?: string | null;
          trade_tickets?: number;
          updated_at?: string;
          user_id: string;
          wood: number;
        };
        Update: {
          created_at?: string;
          crystal?: number;
          gems?: number;
          gold?: number;
          keep_tax_paid_through?: string | null;
          ruler_xp?: number;
          stone?: number;
          time_zone?: string;
          time_zone_set_at?: string | null;
          trade_tickets?: number;
          updated_at?: string;
          user_id?: string;
          wood?: number;
        };
        Relationships: [];
      };
      player_garrison: {
        Row: {
          count: number;
          unit: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          count: number;
          unit: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          count?: number;
          unit?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      player_homes: {
        Row: {
          cell: number;
          set_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          cell: number;
          set_at?: string;
          user_id: string;
        };
        Update: {
          cell?: number;
          set_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      player_state: {
        Row: {
          created_at: string;
          display_name: string | null;
          state: NonNullable<Json>;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          display_name?: string | null;
          state?: NonNullable<Json>;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          display_name?: string | null;
          state?: NonNullable<Json>;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      rest_periods: {
        Row: {
          created_at: string;
          ends_on: string | null;
          id: number;
          starts_on: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          ends_on?: string | null;
          id?: never;
          starts_on: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          ends_on?: string | null;
          id?: never;
          starts_on?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      route_tiles: {
        Row: {
          game_day: string;
          tile: number;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          game_day: string;
          tile: number;
          user_id: string;
        };
        Update: {
          game_day?: string;
          tile?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      site_areas: {
        Row: {
          area: number;
          fail_count: number;
          failed_at: string | null;
          fetched_at: string | null;
          last_error: string | null;
          lease_until: string | null;
          mine_count: number;
          place_count: number;
        };
        ComputedFields: never;
        Insert: {
          area: number;
          fail_count?: number;
          failed_at?: string | null;
          fetched_at?: string | null;
          last_error?: string | null;
          lease_until?: string | null;
          mine_count?: number;
          place_count?: number;
        };
        Update: {
          area?: number;
          fail_count?: number;
          failed_at?: string | null;
          fetched_at?: string | null;
          last_error?: string | null;
          lease_until?: string | null;
          mine_count?: number;
          place_count?: number;
        };
        Relationships: [];
      };
      sites: {
        Row: {
          area: number;
          cell: number;
          geom: unknown;
          id: string;
          kind: string;
          name: string | null;
          subtype: string;
          tags: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          area: number;
          cell: number;
          geom: unknown;
          id: string;
          kind: string;
          name?: string | null;
          subtype: string;
          tags?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          area?: number;
          cell?: number;
          geom?: unknown;
          id?: string;
          kind?: string;
          name?: string | null;
          subtype?: string;
          tags?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [];
      };
      surge_lost_cells: {
        Row: {
          cell: number;
          first_claimed_at: string;
          user_id: string;
          week: string;
        };
        ComputedFields: never;
        Insert: {
          cell: number;
          first_claimed_at: string;
          user_id: string;
          week: string;
        };
        Update: {
          cell?: number;
          first_claimed_at?: string;
          user_id?: string;
          week?: string;
        };
        Relationships: [];
      };
      surge_results: {
        Row: {
          cells_lost: number;
          due_at: string;
          numbers: NonNullable<Json>;
          outcome: string;
          resolved_at: string;
          reward: Json | null;
          units_lost: NonNullable<Json>;
          user_id: string;
          week: string;
        };
        ComputedFields: never;
        Insert: {
          cells_lost?: number;
          due_at: string;
          numbers: NonNullable<Json>;
          outcome: string;
          resolved_at: string;
          reward?: Json | null;
          units_lost?: NonNullable<Json>;
          user_id: string;
          week: string;
        };
        Update: {
          cells_lost?: number;
          due_at?: string;
          numbers?: NonNullable<Json>;
          outcome?: string;
          resolved_at?: string;
          reward?: Json | null;
          units_lost?: NonNullable<Json>;
          user_id?: string;
          week?: string;
        };
        Relationships: [];
      };
      terrain_areas: {
        Row: {
          area: number;
          failed_at: string | null;
          fetched_at: string | null;
          grid: string | null;
          last_error: string | null;
          lease_until: string | null;
        };
        ComputedFields: never;
        Insert: {
          area: number;
          failed_at?: string | null;
          fetched_at?: string | null;
          grid?: string | null;
          last_error?: string | null;
          lease_until?: string | null;
        };
        Update: {
          area?: number;
          failed_at?: string | null;
          fetched_at?: string | null;
          grid?: string | null;
          last_error?: string | null;
          lease_until?: string | null;
        };
        Relationships: [];
      };
      terrain_pending: {
        Row: {
          area: number;
          game_day: string;
          kind: string;
          km: number;
          pos: number;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          area: number;
          game_day: string;
          kind: string;
          km: number;
          pos: number;
          user_id: string;
        };
        Update: {
          area?: number;
          game_day?: string;
          kind?: string;
          km?: number;
          pos?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      walk_points: {
        Row: {
          accuracy_m: number;
          batch_id: string;
          created_at: string;
          geom: unknown;
          id: number;
          paid_segment_start: string | null;
          recorded_at: string;
          session_id: string;
          speed_mps: number | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          accuracy_m: number;
          batch_id: string;
          created_at?: string;
          geom: unknown;
          id?: never;
          paid_segment_start?: string | null;
          recorded_at: string;
          session_id: string;
          speed_mps?: number | null;
          user_id: string;
        };
        Update: {
          accuracy_m?: number;
          batch_id?: string;
          created_at?: string;
          geom?: unknown;
          id?: never;
          paid_segment_start?: string | null;
          recorded_at?: string;
          session_id?: string;
          speed_mps?: number | null;
          user_id?: string;
        };
        Relationships: [];
      };
      walk_sessions: {
        Row: {
          batch_count: number;
          closed_at: string | null;
          created_at: string;
          distance_on_foot_m: number;
          first_point_at: string | null;
          last_point_at: string | null;
          new_cells: number;
          point_count: number;
          rejected_count: number;
          session_id: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          batch_count?: number;
          closed_at?: string | null;
          created_at?: string;
          distance_on_foot_m?: number;
          first_point_at?: string | null;
          last_point_at?: string | null;
          new_cells?: number;
          point_count?: number;
          rejected_count?: number;
          session_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          batch_count?: number;
          closed_at?: string | null;
          created_at?: string;
          distance_on_foot_m?: number;
          first_point_at?: string | null;
          last_point_at?: string | null;
          new_cells?: number;
          point_count?: number;
          rejected_count?: number;
          session_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      build_building: {
        Args: { p_building: string; p_level: number; p_request_id: string };
        Returns: Json;
      };
      claim_detour_areas: {
        Args: { p_lat?: number; p_lng?: number; p_max?: number; p_user: string };
        Returns: {
          area: number;
          request: Json;
        }[];
      };
      claim_site_areas: {
        Args: {
          east: number;
          north: number;
          p_max?: number;
          p_user: string;
          south: number;
          west: number;
        };
        Returns: {
          area: number;
          source: Json;
        }[];
      };
      claim_terrain_areas: {
        Args: { p_max?: number; p_user: string };
        Returns: {
          area: number;
          request: Json;
        }[];
      };
      close_walk_session: { Args: { p_session_id: string }; Returns: Json };
      fail_detour_area: { Args: { p_area: number; p_error: string }; Returns: undefined };
      fail_site_area: { Args: { p_area: number; p_error: string }; Returns: undefined };
      fail_terrain_area: { Args: { p_area: number; p_error: string }; Returns: undefined };
      get_detour_offers: {
        Args: { p_lat?: number; p_lng?: number; p_time_zone?: string };
        Returns: Json;
      };
      get_economy: { Args: { p_time_zone?: string }; Returns: Json };
      get_kingdom: { Args: { p_time_zone?: string }; Returns: Json };
      get_sites: {
        Args: { east: number; north: number; south: number; west: number };
        Returns: {
          id: string;
          kind: string;
          lat: number;
          lng: number;
          name: string;
          subtype: string;
          visibility: string;
        }[];
      };
      get_territory: { Args: Record<PropertyKey, never>; Returns: Json };
      ingest_detour_area: { Args: { p_area: number; p_data: Json }; Returns: Json };
      ingest_site_area: { Args: { p_area: number; p_data: Json }; Returns: Json };
      ingest_terrain_area: { Args: { p_area: number; p_grid: string }; Returns: Json };
      record_app_open: { Args: { p_open_id: string; p_time_zone?: string }; Returns: Json };
      recruit_units: {
        Args: { p_count: number; p_request_id: string; p_unit: string };
        Returns: Json;
      };
      set_rest: { Args: { p_on: boolean }; Returns: Json };
      submit_location_batch: {
        Args: { p_batch_id: string; p_points: Json; p_session_id: string };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
