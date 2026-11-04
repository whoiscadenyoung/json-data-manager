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
      datasets: {
        Row: {
          bbox: unknown;
          created_at: string;
          created_by: string;
          description: string | null;
          edit_policy: string;
          entry_count: number;
          feature_count: number;
          geometry_type: string | null;
          id: string;
          is_geospatial: boolean;
          json_schema: NonNullable<Json>;
          lifecycle: string;
          lineage: Json | null;
          map_tile_archive_built_version: number | null;
          map_tile_archive_bytes: number | null;
          map_tile_archive_format: number | null;
          map_tile_archive_max_zoom: number | null;
          map_tile_archive_path: string | null;
          map_tile_cache_version: number;
          max_geometry_row_bytes: number | null;
          properties: NonNullable<Json>;
          published_visibility: string;
          simplify_geometry: boolean;
          source: Json | null;
          source_file_name: string | null;
          source_file_path: string | null;
          source_file_size: number | null;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          bbox?: unknown;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          edit_policy?: string;
          entry_count?: number;
          feature_count?: number;
          geometry_type?: string | null;
          id?: string;
          is_geospatial?: boolean;
          json_schema?: NonNullable<Json>;
          lifecycle?: string;
          lineage?: Json | null;
          map_tile_archive_built_version?: number | null;
          map_tile_archive_bytes?: number | null;
          map_tile_archive_format?: number | null;
          map_tile_archive_max_zoom?: number | null;
          map_tile_archive_path?: string | null;
          map_tile_cache_version?: number;
          max_geometry_row_bytes?: number | null;
          properties?: NonNullable<Json>;
          published_visibility?: string;
          simplify_geometry?: boolean;
          source?: Json | null;
          source_file_name?: string | null;
          source_file_path?: string | null;
          source_file_size?: number | null;
          title: string;
          updated_at?: string;
        };
        Update: {
          bbox?: unknown;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          edit_policy?: string;
          entry_count?: number;
          feature_count?: number;
          geometry_type?: string | null;
          id?: string;
          is_geospatial?: boolean;
          json_schema?: NonNullable<Json>;
          lifecycle?: string;
          lineage?: Json | null;
          map_tile_archive_built_version?: number | null;
          map_tile_archive_bytes?: number | null;
          map_tile_archive_format?: number | null;
          map_tile_archive_max_zoom?: number | null;
          map_tile_archive_path?: string | null;
          map_tile_cache_version?: number;
          max_geometry_row_bytes?: number | null;
          properties?: NonNullable<Json>;
          published_visibility?: string;
          simplify_geometry?: boolean;
          source?: Json | null;
          source_file_name?: string | null;
          source_file_path?: string | null;
          source_file_size?: number | null;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "datasets_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      entries: {
        Row: {
          created_at: string;
          created_by: string | null;
          data: NonNullable<Json>;
          dataset_id: string;
          geometry_type: string | null;
          id: string;
          search: unknown;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          data: NonNullable<Json>;
          dataset_id: string;
          geometry_type?: string | null;
          id?: string;
          search?: unknown;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          data?: NonNullable<Json>;
          dataset_id?: string;
          geometry_type?: string | null;
          id?: string;
          search?: unknown;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "entries_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entries_dataset_id_fkey";
            columns: ["dataset_id"];
            isOneToOne: false;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
        ];
      };
      entry_references: {
        Row: {
          field_name: string;
          id: string;
          source_dataset_id: string;
          source_entry_id: string;
          target_dataset_id: string;
          target_entry_id: string;
        };
        ComputedFields: never;
        Insert: {
          field_name: string;
          id?: string;
          source_dataset_id: string;
          source_entry_id: string;
          target_dataset_id: string;
          target_entry_id: string;
        };
        Update: {
          field_name?: string;
          id?: string;
          source_dataset_id?: string;
          source_entry_id?: string;
          target_dataset_id?: string;
          target_entry_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "entry_references_source_dataset_id_fkey";
            columns: ["source_dataset_id"];
            isOneToOne: false;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entry_references_source_entry_id_fkey";
            columns: ["source_entry_id"];
            isOneToOne: false;
            referencedRelation: "entries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entry_references_target_dataset_id_fkey";
            columns: ["target_dataset_id"];
            isOneToOne: false;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entry_references_target_entry_id_fkey";
            columns: ["target_entry_id"];
            isOneToOne: false;
            referencedRelation: "entries";
            referencedColumns: ["id"];
          },
        ];
      };
      geometries: {
        Row: {
          bbox: number[] | null;
          created_at: string;
          created_by: string | null;
          dataset_id: string;
          entry_id: string;
          geom: unknown;
          id: string;
          source: Json | null;
          source_bytes: number | null;
          source_path: string | null;
          type: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          bbox?: number[] | null;
          created_at?: string;
          created_by?: string | null;
          dataset_id: string;
          entry_id: string;
          geom?: never;
          id?: string;
          source?: Json | null;
          source_bytes?: number | null;
          source_path?: string | null;
          type: string;
          updated_at?: string;
        };
        Update: {
          bbox?: number[] | null;
          created_at?: string;
          created_by?: string | null;
          dataset_id?: string;
          entry_id?: string;
          geom?: never;
          id?: string;
          source?: Json | null;
          source_bytes?: number | null;
          source_path?: string | null;
          type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "geometries_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "geometries_dataset_id_fkey";
            columns: ["dataset_id"];
            isOneToOne: false;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "geometries_entry_id_fkey";
            columns: ["entry_id"];
            isOneToOne: true;
            referencedRelation: "entries";
            referencedColumns: ["id"];
          },
        ];
      };
      imports: {
        Row: {
          created_at: string;
          created_by: string | null;
          dataset_id: string;
          error: string | null;
          id: string;
          processed: number;
          skipped: number;
          status: string;
          total: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          dataset_id: string;
          error?: string | null;
          id?: string;
          processed?: number;
          skipped?: number;
          status?: string;
          total?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          dataset_id?: string;
          error?: string | null;
          id?: string;
          processed?: number;
          skipped?: number;
          status?: string;
          total?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "imports_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "imports_dataset_id_fkey";
            columns: ["dataset_id"];
            isOneToOne: false;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
        ];
      };
      layer_styles: {
        Row: {
          id: string;
          map_id: string;
          render_id: string;
          style: NonNullable<Json>;
          updated_at: string;
          updated_by: string;
        };
        ComputedFields: never;
        Insert: {
          id?: string;
          map_id: string;
          render_id: string;
          style: NonNullable<Json>;
          updated_at?: string;
          updated_by: string;
        };
        Update: {
          id?: string;
          map_id?: string;
          render_id?: string;
          style?: NonNullable<Json>;
          updated_at?: string;
          updated_by?: string;
        };
        Relationships: [
          {
            foreignKeyName: "layer_styles_map_id_fkey";
            columns: ["map_id"];
            isOneToOne: false;
            referencedRelation: "maps";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "layer_styles_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      map_layer_overrides: {
        Row: {
          child_key: string;
          id: string;
          layer_id: string;
          visible: boolean;
        };
        ComputedFields: never;
        Insert: {
          child_key: string;
          id?: string;
          layer_id: string;
          visible: boolean;
        };
        Update: {
          child_key?: string;
          id?: string;
          layer_id?: string;
          visible?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "map_layer_overrides_layer_id_fkey";
            columns: ["layer_id"];
            isOneToOne: false;
            referencedRelation: "map_layers";
            referencedColumns: ["id"];
          },
        ];
      };
      map_layers: {
        Row: {
          id: string;
          map_id: string;
          order: number;
          target_id: string;
          target_type: string;
          visible: boolean;
        };
        ComputedFields: never;
        Insert: {
          id?: string;
          map_id: string;
          order: number;
          target_id: string;
          target_type: string;
          visible?: boolean;
        };
        Update: {
          id?: string;
          map_id?: string;
          order?: number;
          target_id?: string;
          target_type?: string;
          visible?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "map_layers_map_id_fkey";
            columns: ["map_id"];
            isOneToOne: false;
            referencedRelation: "maps";
            referencedColumns: ["id"];
          },
        ];
      };
      maps: {
        Row: {
          created_at: string;
          created_by: string;
          description: string | null;
          id: string;
          name: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string;
          description?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          description?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "maps_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      marker_sprites: {
        Row: {
          height: number;
          id: string;
          label: string;
          pixel_ratio: number;
          sdf: boolean;
          storage_path: string;
          uploaded_at: string;
          uploaded_by: string;
          width: number;
        };
        ComputedFields: never;
        Insert: {
          height: number;
          id?: string;
          label: string;
          pixel_ratio?: number;
          sdf?: boolean;
          storage_path: string;
          uploaded_at?: string;
          uploaded_by: string;
          width: number;
        };
        Update: {
          height?: number;
          id?: string;
          label?: string;
          pixel_ratio?: number;
          sdf?: boolean;
          storage_path?: string;
          uploaded_at?: string;
          uploaded_by?: string;
          width?: number;
        };
        Relationships: [
          {
            foreignKeyName: "marker_sprites_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          email: string;
          email_verified: boolean;
          id: string;
          image: string | null;
          name: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          email: string;
          email_verified?: boolean;
          id: string;
          image?: string | null;
          name?: string | null;
        };
        Update: {
          created_at?: string;
          email?: string;
          email_verified?: boolean;
          id?: string;
          image?: string | null;
          name?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      can_edit_dataset: { Args: { p_dataset: string }; Returns: boolean };
      can_view_dataset: { Args: { p_dataset: string }; Returns: boolean };
      dataset_id_of_storage_path: { Args: { p_name: string }; Returns: string };
      dataset_rows_for_tiles: {
        Args: { p_cursor?: string; p_dataset: string; p_limit?: number };
        Returns: {
          bbox: number[];
          data: Json;
          entry_id: string;
          geometry: Json;
          geometry_source_path: string;
          geometry_type: string;
          next_cursor: string;
        }[];
      };
      entries_in_bbox: {
        Args: { p_bbox: Json; p_dataset: string };
        Returns: {
          bbox: number[];
          data: Json;
          geometry: Json;
          geometry_type: string;
          id: string;
        }[];
      };
      import_entries: { Args: { p_dataset: string; p_rows: Json }; Returns: number };
      install_tile_archive: {
        Args: {
          p_built_version: number;
          p_bytes: number;
          p_dataset: string;
          p_expected_version: number;
          p_format: number;
          p_max_zoom: number;
          p_path: string;
        };
        Returns: boolean;
      };
      search_entries: {
        Args: {
          p_cursor?: string;
          p_dataset: string;
          p_filters?: Json;
          p_limit?: number;
          p_query?: string;
          p_sort?: Json;
        };
        Returns: {
          created_at: string;
          data: Json;
          geometry_type: string;
          id: string;
          next_cursor: string;
        }[];
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
