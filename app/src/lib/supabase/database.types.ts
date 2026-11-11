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
      apps: {
        Row: {
          created_at: string;
          created_by: string;
          dataset_ids: string[];
          description: string | null;
          example: boolean;
          id: string;
          pages: NonNullable<Json>;
          revision: number;
          visibility: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string;
          dataset_ids?: string[];
          description?: string | null;
          example?: boolean;
          id?: string;
          pages?: NonNullable<Json>;
          revision?: number;
          visibility?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          dataset_ids?: string[];
          description?: string | null;
          example?: boolean;
          id?: string;
          pages?: NonNullable<Json>;
          revision?: number;
          visibility?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "apps_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      binding_entries: {
        Row: {
          binding_id: string;
          entry_id: string;
          entry_key: string;
          id: string;
          seen_run: string | null;
        };
        ComputedFields: never;
        Insert: {
          binding_id: string;
          entry_id: string;
          entry_key: string;
          id?: string;
          seen_run?: string | null;
        };
        Update: {
          binding_id?: string;
          entry_id?: string;
          entry_key?: string;
          id?: string;
          seen_run?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "binding_entries_binding_id_fkey";
            columns: ["binding_id"];
            isOneToOne: false;
            referencedRelation: "dataset_bindings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "binding_entries_entry_id_fkey";
            columns: ["entry_id"];
            isOneToOne: false;
            referencedRelation: "entries";
            referencedColumns: ["id"];
          },
        ];
      };
      collection_datasets: {
        Row: {
          collection_id: string;
          dataset_id: string;
          kind: string | null;
        };
        ComputedFields: never;
        Insert: {
          collection_id: string;
          dataset_id: string;
          kind?: string | null;
        };
        Update: {
          collection_id?: string;
          dataset_id?: string;
          kind?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "collection_datasets_collection_id_fkey";
            columns: ["collection_id"];
            isOneToOne: false;
            referencedRelation: "collections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "collection_datasets_dataset_id_fkey";
            columns: ["dataset_id"];
            isOneToOne: false;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
        ];
      };
      collections: {
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
            foreignKeyName: "collections_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      commit_mirror: {
        Row: {
          applied_at: string;
          at: string;
          binding_id: string;
          foreign_commit_id: string;
          id: string;
          message: string;
          ops: NonNullable<Json>;
          seq: number;
        };
        ComputedFields: never;
        Insert: {
          applied_at?: string;
          at: string;
          binding_id: string;
          foreign_commit_id: string;
          id?: string;
          message: string;
          ops?: NonNullable<Json>;
          seq: number;
        };
        Update: {
          applied_at?: string;
          at?: string;
          binding_id?: string;
          foreign_commit_id?: string;
          id?: string;
          message?: string;
          ops?: NonNullable<Json>;
          seq?: number;
        };
        Relationships: [
          {
            foreignKeyName: "commit_mirror_binding_id_fkey";
            columns: ["binding_id"];
            isOneToOne: false;
            referencedRelation: "dataset_bindings";
            referencedColumns: ["id"];
          },
        ];
      };
      consumer_references: {
        Row: {
          consumer_id: string;
          consumer_kind: string;
          created_at: string;
          id: string;
          mode: string;
          pinned_ref: string | null;
          pinned_version_id: string | null;
          source_dataset_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          consumer_id: string;
          consumer_kind: string;
          created_at?: string;
          id?: string;
          mode?: string;
          pinned_ref?: string | null;
          pinned_version_id?: string | null;
          source_dataset_id?: string | null;
        };
        Update: {
          consumer_id?: string;
          consumer_kind?: string;
          created_at?: string;
          id?: string;
          mode?: string;
          pinned_ref?: string | null;
          pinned_version_id?: string | null;
          source_dataset_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "consumer_references_pinned_version_id_fkey";
            columns: ["pinned_version_id"];
            isOneToOne: false;
            referencedRelation: "dataset_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consumer_references_source_dataset_id_fkey";
            columns: ["source_dataset_id"];
            isOneToOne: false;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
        ];
      };
      dataset_activity: {
        Row: {
          added: number;
          binding_id: string;
          entry_count: number;
          id: string;
          kind: string | null;
          needs_reconcile: boolean | null;
          ops: NonNullable<Json>;
          removed: number;
          synced_at: string;
          truncated: boolean | null;
          updated: number;
        };
        ComputedFields: never;
        Insert: {
          added?: number;
          binding_id: string;
          entry_count?: number;
          id?: string;
          kind?: string | null;
          needs_reconcile?: boolean | null;
          ops?: NonNullable<Json>;
          removed?: number;
          synced_at: string;
          truncated?: boolean | null;
          updated?: number;
        };
        Update: {
          added?: number;
          binding_id?: string;
          entry_count?: number;
          id?: string;
          kind?: string | null;
          needs_reconcile?: boolean | null;
          ops?: NonNullable<Json>;
          removed?: number;
          synced_at?: string;
          truncated?: boolean | null;
          updated?: number;
        };
        Relationships: [
          {
            foreignKeyName: "dataset_activity_binding_id_fkey";
            columns: ["binding_id"];
            isOneToOne: false;
            referencedRelation: "dataset_bindings";
            referencedColumns: ["id"];
          },
        ];
      };
      dataset_bindings: {
        Row: {
          created_at: string;
          dataset_id: string;
          id: string;
          keep_versions: number | null;
          last_applied_commit_id: string | null;
          last_applied_commit_seq: number | null;
          last_reconciled_at: string | null;
          last_synced_at: string | null;
          pinned_refs: string[];
          remote_revision: number | null;
          remote_schema_version: string | null;
          schema_mapping: Json | null;
          source: string;
          source_updated_at: string | null;
          synced_entry_count: number | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          dataset_id: string;
          id?: string;
          keep_versions?: number | null;
          last_applied_commit_id?: string | null;
          last_applied_commit_seq?: number | null;
          last_reconciled_at?: string | null;
          last_synced_at?: string | null;
          pinned_refs?: string[];
          remote_revision?: number | null;
          remote_schema_version?: string | null;
          schema_mapping?: Json | null;
          source: string;
          source_updated_at?: string | null;
          synced_entry_count?: number | null;
        };
        Update: {
          created_at?: string;
          dataset_id?: string;
          id?: string;
          keep_versions?: number | null;
          last_applied_commit_id?: string | null;
          last_applied_commit_seq?: number | null;
          last_reconciled_at?: string | null;
          last_synced_at?: string | null;
          pinned_refs?: string[];
          remote_revision?: number | null;
          remote_schema_version?: string | null;
          schema_mapping?: Json | null;
          source?: string;
          source_updated_at?: string | null;
          synced_entry_count?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "dataset_bindings_dataset_id_fkey";
            columns: ["dataset_id"];
            isOneToOne: true;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "dataset_bindings_source_fkey";
            columns: ["source"];
            isOneToOne: false;
            referencedRelation: "remote_sources";
            referencedColumns: ["source"];
          },
        ];
      };
      dataset_versions: {
        Row: {
          created_at: string;
          created_by: string;
          dataset_id: string;
          id: string;
          lineage: NonNullable<Json>;
          publish_key: string | null;
          ref: string;
          version_label: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by: string;
          dataset_id: string;
          id?: string;
          lineage: NonNullable<Json>;
          publish_key?: string | null;
          ref: string;
          version_label: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          dataset_id?: string;
          id?: string;
          lineage?: NonNullable<Json>;
          publish_key?: string | null;
          ref?: string;
          version_label?: string;
        };
        Relationships: [
          {
            foreignKeyName: "dataset_versions_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "dataset_versions_dataset_id_fkey";
            columns: ["dataset_id"];
            isOneToOne: false;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
        ];
      };
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
          group_id: string | null;
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
          visibility: string;
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
          group_id?: string | null;
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
          visibility?: string;
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
          group_id?: string | null;
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
          visibility?: string;
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
          {
            foreignKeyName: "datasets_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "groups";
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
      groups: {
        Row: {
          collection_id: string | null;
          created_at: string;
          created_by: string;
          description: string | null;
          id: string;
          name: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          collection_id?: string | null;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          collection_id?: string | null;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "groups_collection_id_fkey";
            columns: ["collection_id"];
            isOneToOne: false;
            referencedRelation: "collections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "groups_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
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
      project_artifacts: {
        Row: {
          added_by: string;
          artifact_id: string;
          artifact_kind: string;
          id: string;
          project_id: string;
        };
        ComputedFields: never;
        Insert: {
          added_by: string;
          artifact_id: string;
          artifact_kind: string;
          id?: string;
          project_id: string;
        };
        Update: {
          added_by?: string;
          artifact_id?: string;
          artifact_kind?: string;
          id?: string;
          project_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_artifacts_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_artifacts_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      projects: {
        Row: {
          artifact_count: number;
          created_at: string;
          created_by: string;
          description: string | null;
          id: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          artifact_count?: number;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          id?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          artifact_count?: number;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          id?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "projects_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      publish_bundle_members: {
        Row: {
          attempt_id: string | null;
          bundle_id: string;
          dataset_key: string;
          error: string | null;
          group_id: string | null;
          id: string;
          kind: string;
          layer_targets: string[] | null;
          publish: boolean;
          published_version_id: string | null;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          attempt_id?: string | null;
          bundle_id: string;
          dataset_key: string;
          error?: string | null;
          group_id?: string | null;
          id?: string;
          kind: string;
          layer_targets?: string[] | null;
          publish?: boolean;
          published_version_id?: string | null;
          status?: string;
        };
        Update: {
          attempt_id?: string | null;
          bundle_id?: string;
          dataset_key?: string;
          error?: string | null;
          group_id?: string | null;
          id?: string;
          kind?: string;
          layer_targets?: string[] | null;
          publish?: boolean;
          published_version_id?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "publish_bundle_members_bundle_id_fkey";
            columns: ["bundle_id"];
            isOneToOne: false;
            referencedRelation: "publish_bundles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "publish_bundle_members_published_version_id_fkey";
            columns: ["published_version_id"];
            isOneToOne: false;
            referencedRelation: "dataset_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      publish_bundles: {
        Row: {
          collection_id: string | null;
          created_by: string;
          error: string | null;
          finished_at: string | null;
          id: string;
          last_progress_at: string;
          project_description: string | null;
          project_id: string;
          started_at: string;
          status: string;
          title: string;
        };
        ComputedFields: never;
        Insert: {
          collection_id?: string | null;
          created_by: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          last_progress_at?: string;
          project_description?: string | null;
          project_id: string;
          started_at?: string;
          status?: string;
          title: string;
        };
        Update: {
          collection_id?: string | null;
          created_by?: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          last_progress_at?: string;
          project_description?: string | null;
          project_id?: string;
          started_at?: string;
          status?: string;
          title?: string;
        };
        Relationships: [
          {
            foreignKeyName: "publish_bundles_collection_id_fkey";
            columns: ["collection_id"];
            isOneToOne: false;
            referencedRelation: "collections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "publish_bundles_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "publish_bundles_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      remote_sources: {
        Row: {
          checked_at: string | null;
          error: string | null;
          layer: Json | null;
          record_url_template: string | null;
          source: string;
        };
        ComputedFields: never;
        Insert: {
          checked_at?: string | null;
          error?: string | null;
          layer?: Json | null;
          record_url_template?: string | null;
          source: string;
        };
        Update: {
          checked_at?: string | null;
          error?: string | null;
          layer?: Json | null;
          record_url_template?: string | null;
          source?: string;
        };
        Relationships: [];
      };
      sync_runs: {
        Row: {
          added: number;
          applied: number;
          binding_id: string;
          chunk_index: number;
          chunk_paths: string[];
          claim: string | null;
          collect_attempts: number | null;
          error: string | null;
          finished_at: string | null;
          id: string;
          last_commit_id: string | null;
          last_progress_at: string;
          last_seq: number | null;
          mode: string;
          needs_reconcile: boolean | null;
          ops: NonNullable<Json>;
          remote_revision: number | null;
          removed: number;
          row_offset: number;
          started_at: string;
          status: string;
          total: number;
          truncated: boolean;
          updated: number;
        };
        ComputedFields: never;
        Insert: {
          added?: number;
          applied?: number;
          binding_id: string;
          chunk_index?: number;
          chunk_paths?: string[];
          claim?: string | null;
          collect_attempts?: number | null;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          last_commit_id?: string | null;
          last_progress_at?: string;
          last_seq?: number | null;
          mode: string;
          needs_reconcile?: boolean | null;
          ops?: NonNullable<Json>;
          remote_revision?: number | null;
          removed?: number;
          row_offset?: number;
          started_at?: string;
          status: string;
          total?: number;
          truncated?: boolean;
          updated?: number;
        };
        Update: {
          added?: number;
          applied?: number;
          binding_id?: string;
          chunk_index?: number;
          chunk_paths?: string[];
          claim?: string | null;
          collect_attempts?: number | null;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          last_commit_id?: string | null;
          last_progress_at?: string;
          last_seq?: number | null;
          mode?: string;
          needs_reconcile?: boolean | null;
          ops?: NonNullable<Json>;
          remote_revision?: number | null;
          removed?: number;
          row_offset?: number;
          started_at?: string;
          status?: string;
          total?: number;
          truncated?: boolean;
          updated?: number;
        };
        Relationships: [
          {
            foreignKeyName: "sync_runs_binding_id_fkey";
            columns: ["binding_id"];
            isOneToOne: false;
            referencedRelation: "dataset_bindings";
            referencedColumns: ["id"];
          },
        ];
      };
      tags: {
        Row: {
          created_at: string;
          created_by: string;
          dataset_id: string;
          id: string;
          name: string;
          retired_at: string | null;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string;
          dataset_id: string;
          id?: string;
          name: string;
          retired_at?: string | null;
          version_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          dataset_id?: string;
          id?: string;
          name?: string;
          retired_at?: string | null;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tags_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tags_dataset_id_fkey";
            columns: ["dataset_id"];
            isOneToOne: false;
            referencedRelation: "datasets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tags_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "dataset_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      version_entries: {
        Row: {
          bbox: number[] | null;
          data: NonNullable<Json>;
          entry_id: string | null;
          geometry: Json | null;
          geometry_type: string | null;
          id: string;
          ordinal: number;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          bbox?: number[] | null;
          data: NonNullable<Json>;
          entry_id?: string | null;
          geometry?: Json | null;
          geometry_type?: string | null;
          id?: string;
          ordinal: number;
          version_id: string;
        };
        Update: {
          bbox?: number[] | null;
          data?: NonNullable<Json>;
          entry_id?: string | null;
          geometry?: Json | null;
          geometry_type?: string | null;
          id?: string;
          ordinal?: number;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "version_entries_entry_id_fkey";
            columns: ["entry_id"];
            isOneToOne: false;
            referencedRelation: "entries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "version_entries_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "dataset_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      version_policies: {
        Row: {
          dataset_key: string;
          keep_versions: number | null;
          pinned_refs: string[];
        };
        ComputedFields: never;
        Insert: {
          dataset_key: string;
          keep_versions?: number | null;
          pinned_refs?: string[];
        };
        Update: {
          dataset_key?: string;
          keep_versions?: number | null;
          pinned_refs?: string[];
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      binding_activity_ops_limit: { Args: Record<PropertyKey, never>; Returns: number };
      binding_apply_commit_op: {
        Args: {
          p_binding: Omit<
            Database["public"]["Tables"]["dataset_bindings"]["Row"],
            Database["public"]["Tables"]["dataset_bindings"]["ComputedFields"]
          >;
          p_op: Json;
          p_run_id: string;
          p_tally: Json;
        };
        Returns: Json;
      };
      binding_apply_commits_batch: {
        Args: {
          p_chunk_index: number;
          p_claim: string;
          p_commits: Json;
          p_row_offset: number;
          p_run_id: string;
        };
        Returns: Json;
      };
      binding_apply_row: {
        Args: {
          p_binding: Omit<
            Database["public"]["Tables"]["dataset_bindings"]["Row"],
            Database["public"]["Tables"]["dataset_bindings"]["ComputedFields"]
          >;
          p_row: Json;
          p_run_id: string;
          p_tally: Json;
        };
        Returns: Json;
      };
      binding_apply_rows_batch: {
        Args: {
          p_chunk_index: number;
          p_claim: string;
          p_row_offset: number;
          p_rows: Json;
          p_run_id: string;
        };
        Returns: Json;
      };
      binding_build_geometry: { Args: { p_data: Json; p_mapping: Json }; Returns: Json };
      binding_claim_run: { Args: { p_run_id: string }; Returns: string };
      binding_commit_mirror_limit: { Args: Record<PropertyKey, never>; Returns: number };
      binding_complete_run: { Args: { p_run_id: string }; Returns: undefined };
      binding_ensure: {
        Args: { p_dataset: Json; p_schema_mapping?: Json; p_source: string };
        Returns: string;
      };
      binding_fail_run: {
        Args: { p_claim: string; p_error: string; p_run_id: string };
        Returns: undefined;
      };
      binding_finalize_run: { Args: { p_claim: string; p_run_id: string }; Returns: undefined };
      binding_for_source: {
        Args: { p_source: string };
        Returns: {
          created_at: string;
          dataset_id: string;
          id: string;
          keep_versions: number | null;
          last_applied_commit_id: string | null;
          last_applied_commit_seq: number | null;
          last_reconciled_at: string | null;
          last_synced_at: string | null;
          pinned_refs: string[];
          remote_revision: number | null;
          remote_schema_version: string | null;
          schema_mapping: Json | null;
          source: string;
          source_updated_at: string | null;
          synced_entry_count: number | null;
        };
        SetofOptions: {
          from: "*";
          to: "dataset_bindings";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      binding_mark_collected: {
        Args: {
          p_chunk_paths: string[];
          p_claim: string;
          p_last_commit_id?: string;
          p_last_seq?: number;
          p_remote_revision?: number;
          p_run_id: string;
          p_total: number;
        };
        Returns: boolean;
      };
      binding_max_collect_attempts: { Args: Record<PropertyKey, never>; Returns: number };
      binding_op_detail: { Args: { p_op: Json }; Returns: string };
      binding_op_label: { Args: { p_op: Json }; Returns: string };
      binding_patch_run_batch: {
        Args: {
          p_applied: number;
          p_chunk_index: number;
          p_row_offset: number;
          p_run_id: string;
          p_tally: Json;
        };
        Returns: undefined;
      };
      binding_record_op: {
        Args: { p_detail?: string; p_label: string; p_op: string; p_tally: Json };
        Returns: Json;
      };
      binding_row_detail: { Args: { p_after: Json; p_before: Json }; Returns: string };
      binding_row_label: { Args: { p_data: Json; p_key: string }; Returns: string };
      binding_run_state: { Args: { p_run_id: string }; Returns: Json };
      binding_schedule_reconciles: { Args: Record<PropertyKey, never>; Returns: number };
      binding_stale_run_interval: { Args: Record<PropertyKey, never>; Returns: string };
      binding_start_run: {
        Args: { p_mode: string; p_source: string };
        Returns: {
          already_running: boolean;
          claim: string;
          run_id: string;
        }[];
      };
      binding_sweep_batch: { Args: { p_claim: string; p_run_id: string }; Returns: number };
      binding_sweep_batch_size: { Args: Record<PropertyKey, never>; Returns: number };
      binding_tally_bump: { Args: { p_by: number; p_field: string; p_tally: Json }; Returns: Json };
      binding_unbind: { Args: { p_binding_id: string }; Returns: undefined };
      binding_write_geometry: {
        Args: { p_dataset_id: string; p_entry_id: string; p_geometry: Json };
        Returns: undefined;
      };
      can_edit_dataset: { Args: { p_dataset: string }; Returns: boolean };
      can_view_dataset: { Args: { p_dataset: string }; Returns: boolean };
      consumer_reference_owner: { Args: { p_consumer: string; p_kind: string }; Returns: boolean };
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
      enforce_version_retention: { Args: { p_dataset: string }; Returns: number };
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
      is_bound_dataset: { Args: { p_dataset: string }; Returns: boolean };
      project_artifact_owner: { Args: { p_project: string }; Returns: boolean };
      publish_bundle_owner: { Args: { p_bundle: string }; Returns: boolean };
      publish_version: {
        Args: {
          p_dataset: string;
          p_lineage?: Json;
          p_publish_key: string;
          p_version_label: string;
        };
        Returns: string;
      };
      remote_source_check: {
        Args: {
          p_error?: string;
          p_layer?: Json;
          p_ok: boolean;
          p_record_url_template?: string;
          p_source: string;
        };
        Returns: undefined;
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
      system_examples_owner: { Args: Record<PropertyKey, never>; Returns: string };
      version_policy_anchor_owner: { Args: { p_anchor: string }; Returns: boolean };
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
