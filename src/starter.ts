/**
 * Starter schema content offered when the configured base schema file is missing.
 * Everything here is generic example content — the user edits it to describe their
 * own vault. See docs/SCHEMA.md for the full format.
 */

export const STARTER_BASE_YAML = `# Vault Warden vault schema — applies to every note in the vault.
# See the plugin's docs/SCHEMA.md for the full format.
base_schema_version: 1

# Base fields checked on EVERY note. Only area/notetype/origin carry rules
# (FM-AREA-*, FM-NOTETYPE-*, FM-ORIGIN-*). select:<Source> / multi:<Source>
# resolve against line-per-value notes in the folder ABOVE this one
# (e.g. "select:Areas" reads "../Areas.md").
fields:
  area:
    type: select:Areas
    required: true
  # notetype:
  #   type: multi:Note Types
  #   required: true
  #   required_unless: class   # optional once a class types the note
  # origin:
  #   type: select:Origin
  #   required: true

tags:
  # Max '/'-separated levels per tag (TAG-DEPTH).
  max_depth: 2
  # Tags to remove on sight (TAG-RETIRED, matched case-insensitively).
  retired: []

dates:
  # Any frontmatter field ending in these suffixes gets ISO date checking
  # (DATE-FORMAT), even on notes with no class.
  name_suffixes: [_date, _deadline]
  # Date fields never format-checked.
  presence_only: [created]

# Extra frontmatter stamped alongside class: when the creation hook fires for
# a note created inside a class_locations-mapped folder.
creation_stamp:
  origin: manual
`;

export const STARTER_CLASS_YAML = `# Example Vault Warden class manifest — one file like this per note class,
# in the same folder as the vault schema. The class: key is authoritative;
# the filename is convention only.
manifest_version: 1
class: ExampleClass
fields:
  created: {type: date, required: true}
  status:
    type: select
    required: true
    values: [Draft, Active, Done]
  related: {type: wikilink}
  links: {type: list}
  priority: {type: number}
  reference_url: {type: url}
  summary: {type: text}
`;

export const STARTER_LOCATIONS_YAML = `# Folder -> class map (CLASS-EXPECTED / CLASS-MISFILED and the creation hook).
# Plain vault-relative string prefixes; longest match wins.
locations: []
#  - prefix: "Projects/Examples/"
#    class: ExampleClass
`;

export const STARTER_CLASS_FILENAME = "ExampleClass.yaml";
export const STARTER_LOCATIONS_FILENAME = "class_locations.yaml";
