import { describe, it, expect } from 'vitest';
import { snippetToHtml } from '@/composables/use-message-search';

describe('snippetToHtml', () => {
  it('wraps **match** in <mark>', () => {
    expect(snippetToHtml('hello **world**')).toBe('hello <mark>world</mark>');
  });

  it('handles multiple match markers', () => {
    expect(snippetToHtml('**a** and **b**')).toBe('<mark>a</mark> and <mark>b</mark>');
  });

  it('escapes HTML special chars BEFORE wrapping', () => {
    // Content with literal < > & — must be escaped first
    expect(snippetToHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('XSS safety: <script> tags in content are neutralized', () => {
    const evil = '<script>alert(1)</script>';
    const out = snippetToHtml(evil);
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('XSS safety: image with onerror is neutralized', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const out = snippetToHtml(evil);
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('<img');
  });

  it('XSS safety: ** in content alongside markers is rendered correctly', () => {
    // Inner content has both literal HTML and our mark markers
    const tricky = 'before **<script>x</script>** after';
    const out = snippetToHtml(tricky);
    // The match content was escaped, then wrapped in <mark>
    expect(out).toBe('before <mark>&lt;script&gt;x&lt;/script&gt;</mark> after');
  });

  it('handles content with no markers', () => {
    expect(snippetToHtml('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(snippetToHtml('')).toBe('');
  });

  it('handles non-greedy match (does not eat past next **)', () => {
    expect(snippetToHtml('**a** and **b** here')).toBe(
      '<mark>a</mark> and <mark>b</mark> here',
    );
  });

  it('preserves Vietnamese characters', () => {
    expect(snippetToHtml('Chào **bảng giá** nhé')).toBe(
      'Chào <mark>bảng giá</mark> nhé',
    );
  });
});
