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
      walk_points: {
        Row: {
          accuracy_m: number;
          batch_id: string;
          created_at: string;
          geom: unknown;
          id: number;
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
      get_territory: { Args: Record<PropertyKey, never>; Returns: Json };
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
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
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
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
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
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
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
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
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
