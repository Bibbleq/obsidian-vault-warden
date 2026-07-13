/**
 * Starter schema content offered when the configured base schema file is missing.
 * Everything here is generic example content — the user edits it to describe their
 * own vault. See docs/SCHEMA.md for the full format.
 */

export const STARTER_BASE_YAML = `# Vault Warden base schema
# This file drives all validation. See the plugin's docs/SCHEMA.md for the format.
version: 1

# Folder of "line-list" notes used by select: field types (one valid value per line;
# blank lines and lines starting with '#' are ignored).
metadata_sources: "_vault/Metadata Sources"

# Frontmatter key that names a note's class.
class_key: class

# Frontmatter key listing rule IDs a note may opt out of.
ignore_key: validator_ignore

# Optional frontmatter property to keep in sync with the H1/filename (future feature).
# Empty string = disabled.
frontmatter_title: ""

# Folder -> class map. Notes created in (or found in) these folders belong to the
# mapped class. Uncomment and adapt:
# class_locations:
#   "Projects/Recipes": Recipe

# Extra keys stamped on new notes created inside a class_locations folder.
creation_stamp:
  origin: manual

# Rules run only if listed here. fix: auto | confirm | none is the fix tier
# (auto = content-preserving, confirm = one-click, none = report only).
rules:
  CLASS-FIELD-MISSING: { fix: confirm }
  CLASS-FIELD-TYPE: { fix: none }
  DATE-FORMAT:
    fix: auto
    formats:
      - "YYYY-MM-DD"
      - "YYYY-MM-DDTHH:mm"
      - "YYYY-MM-DDTHH:mm:ss"
  TAG-CASE:
    fix: auto
    style: pascal
  TAG-RETIRED:
    fix: confirm
    map: {}
  # FM-AREA-INVALID:
  #   fix: confirm
  #   field: area
  #   source: Areas
  CLASS-UNDECLARED: { fix: auto }

# Filename <-> H1 sync configuration (future feature; defined now for forward
# compatibility).
title_sync:
  strip: ":|#^[]\\\\/?"
  replacement: ""
  ignore:
    - "_vault/Templates/"
`;

export const STARTER_CLASS_YAML = `# Example Vault Warden class manifest.
# One file like this per note class, in the same folder as base.yaml.
# The class: key is authoritative; the filename is convention only.
class: ExampleClass
fields:
  created:
    type: date
    required: true
  area:
    type: select:Areas
  tags:
    type: list
  related:
    type: wikilink
  summary:
    type: text
`;

export const STARTER_CLASS_FILENAME = "ExampleClass.yaml";
