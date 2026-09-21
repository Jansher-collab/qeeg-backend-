import fs from 'fs';
import path from 'path';

export interface ChecklistDomain {
  num: number;
  key: string;
  page: number;
  title: string;
  desc: string;
}

export interface ChecklistSectionField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'checkbox' | 'date' | 'select';
  required?: boolean;
  readonly?: boolean;
  source?: string;
  placeholder?: string;
  detail?: string;
  options?: { value: string; label: string }[];
}

export interface ChecklistSection {
  key: string;
  title: string;
  kind?: 'fields' | 'domains' | 'static';
  readonly?: boolean;
  required?: boolean;
  insight?: string;
  domainPage?: number;
  lines?: string[];
  fields?: ChecklistSectionField[];
}

export interface ChecklistDefinition {
  version: number;
  description?: string;
  likert: Record<string, string>;
  domains: ChecklistDomain[];
  sections?: ChecklistSection[];
}

let cached: ChecklistDefinition | null = null;

const CONFIG_PATH = path.join(process.cwd(), 'config', 'checklist-definition.json');

function validate(raw: ChecklistDefinition): ChecklistDefinition {
  if (!raw.domains || !Array.isArray(raw.domains)) {
    throw new Error('checklist-definition.json: "domains" array is missing.');
  }
  if (raw.domains.length !== 11) {
    throw new Error(`checklist-definition.json: expected 11 domains, got ${raw.domains.length}.`);
  }

  const keys = new Set<string>();
  for (const d of raw.domains) {
    if (!/^domain_\d+$/.test(d.key)) {
      throw new Error(`checklist-definition.json: invalid domain key "${d.key}".`);
    }
    if (keys.has(d.key)) {
      throw new Error(`checklist-definition.json: duplicate domain key "${d.key}".`);
    }
    keys.add(d.key);
    if (!d.title || !d.desc) {
      throw new Error(`checklist-definition.json: domain "${d.key}" requires title and desc.`);
    }
    if (d.page !== 2 && d.page !== 3) {
      throw new Error(`checklist-definition.json: domain "${d.key}" page must be 2 or 3.`);
    }
    if (!Number.isInteger(d.num) || d.num < 1 || d.num > 11) {
      throw new Error(`checklist-definition.json: domain "${d.key}" num must be 1-11.`);
    }
  }

  for (const rating of ['0', '1', '2', '3', '4']) {
    if (!raw.likert || typeof raw.likert[rating] !== 'string') {
      throw new Error(`checklist-definition.json: likert label for "${rating}" is required.`);
    }
  }

  if (raw.sections !== undefined) {
    if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
      throw new Error('checklist-definition.json: "sections" must be a non-empty array.');
    }
    const sectionKeys = new Set<string>();
    const fieldKeys = new Set<string>();
    for (const s of raw.sections) {
      if (!s.key || sectionKeys.has(s.key)) {
        throw new Error(`checklist-definition.json: section key "${s.key}" is missing or duplicated.`);
      }
      sectionKeys.add(s.key);
      if (!s.title) {
        throw new Error(`checklist-definition.json: section "${s.key}" requires a title.`);
      }
      const kind = s.kind ?? 'fields';
      if (kind === 'domains') {
        if (s.domainPage !== 2 && s.domainPage !== 3) {
          throw new Error(`checklist-definition.json: section "${s.key}" (kind domains) requires domainPage 2 or 3.`);
        }
      } else if (kind === 'static') {
        if (!Array.isArray(s.lines) || s.lines.length === 0) {
          throw new Error(`checklist-definition.json: section "${s.key}" (kind static) requires non-empty lines.`);
        }
      } else if (kind === 'fields') {
        if (!Array.isArray(s.fields) || s.fields.length === 0) {
          throw new Error(`checklist-definition.json: section "${s.key}" (kind fields) requires a non-empty fields array.`);
        }
        for (const f of s.fields) {
          if (!f.key || fieldKeys.has(f.key)) {
            throw new Error(`checklist-definition.json: field key "${f.key}" is missing or duplicated across sections.`);
          }
          fieldKeys.add(f.key);
          if (!f.label) {
            throw new Error(`checklist-definition.json: field "${f.key}" requires a label.`);
          }
          if (!['text', 'textarea', 'checkbox', 'date', 'select'].includes(f.type)) {
            throw new Error(`checklist-definition.json: field "${f.key}" has unsupported type "${f.type}".`);
          }
          if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
            throw new Error(`checklist-definition.json: field "${f.key}" (select) requires options.`);
          }
        }
      } else {
        throw new Error(`checklist-definition.json: section "${s.key}" has unsupported kind "${kind}".`);
      }
    }
  }

  return raw;
}

/**
 * Loads (and caches) the checklist definition from config/checklist-definition.json.
 * Validation is fail-fast so a corrupt config is caught at startup.
 */
export function loadChecklistDefinition(forceReload = false): ChecklistDefinition {
  if (cached && !forceReload) return cached;
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as ChecklistDefinition;
  cached = validate(raw);
  return cached;
}

export function getChecklistDomainsForPage(page: number): ChecklistDomain[] {
  return loadChecklistDefinition()
    .domains.filter((d) => d.page === page)
    .sort((a, b) => a.num - b.num);
}

export function getLikertLabel(rating: number): string {
  return loadChecklistDefinition().likert[String(rating)] ?? String(rating);
}

export function getChecklistSections(): ChecklistSection[] {
  return loadChecklistDefinition().sections ?? [];
}