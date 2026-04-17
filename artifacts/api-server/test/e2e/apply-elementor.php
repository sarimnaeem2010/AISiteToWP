#!/usr/bin/env php
<?php
/**
 * Bootstraps WP, ensures the Elementor plugin is active, switches to the
 * supplied theme, and creates (or updates) a page driven by Elementor:
 * `_elementor_data` is read from stdin (JSON array produced by
 * composeElementorData()), and the post meta required for Elementor to
 * take over the_content is set. Prints the new page id on stdout.
 *
 * usage: apply-elementor.php <wp-dir> <theme-slug> <page-slug> <page-title>
 */
$wp_dir     = $argv[1] ?? null;
$theme_slug = $argv[2] ?? null;
$page_slug  = $argv[3] ?? null;
$page_title = $argv[4] ?? 'Home (Elementor)';

if (!$wp_dir || !$theme_slug || !$page_slug) {
    fwrite(STDERR, "usage: apply-elementor.php <wp-dir> <theme-slug> <page-slug> <page-title>\n");
    exit(1);
}

$_SERVER['HTTP_HOST']   = 'localhost';
$_SERVER['REQUEST_URI'] = '/';
require_once $wp_dir . '/wp-load.php';
require_once $wp_dir . '/wp-admin/includes/plugin.php';

$elementor_data = stream_get_contents(STDIN);
if (json_decode($elementor_data) === null && json_last_error() !== JSON_ERROR_NONE) {
    fwrite(STDERR, "[apply-elementor] stdin is not valid JSON: " . json_last_error_msg() . "\n");
    exit(1);
}

// Activate Elementor. activate_plugin() returns null on success, WP_Error
// on failure. is_plugin_active() short-circuits subsequent runs.
if (!is_plugin_active('elementor/elementor.php')) {
    $res = activate_plugin('elementor/elementor.php');
    if (is_wp_error($res)) {
        fwrite(STDERR, "[apply-elementor] failed to activate elementor: " . $res->get_error_message() . "\n");
        exit(2);
    }
}
if (!is_plugin_active('elementor/elementor.php')) {
    fwrite(STDERR, "[apply-elementor] elementor still inactive after activate_plugin\n");
    exit(2);
}

// Inline Elementor's per-post CSS so we don't need a writable uploads dir
// or a second request to fetch the generated stylesheet — we only care
// about HTML structure here, not styling.
update_option('elementor_css_print_method', 'internal');

switch_theme($theme_slug);
$active = wp_get_theme()->get_stylesheet();
if ($active !== $theme_slug) {
    fwrite(STDERR, "[apply-elementor] failed to activate theme; active=$active\n");
    exit(3);
}

update_option('permalink_structure', '/%postname%/');
flush_rewrite_rules(false);

$existing = get_page_by_path($page_slug);
$post_arr = array(
    'post_title'   => $page_title,
    'post_name'    => $page_slug,
    'post_status'  => 'publish',
    'post_type'    => 'page',
    // Elementor replaces the_content via filter, so the raw post_content
    // is irrelevant — leave it empty so a misconfigured render falls back
    // to a blank page (loud failure) rather than masking the bug.
    'post_content' => '',
);
if ($existing) {
    $post_arr['ID'] = $existing->ID;
    $id = wp_update_post($post_arr, true);
} else {
    $id = wp_insert_post($post_arr, true);
}
if (is_wp_error($id)) {
    fwrite(STDERR, "[apply-elementor] insert/update failed: " . $id->get_error_message() . "\n");
    exit(4);
}

// The minimum meta surface Elementor's frontend looks for to take over
// the_content for this post. _elementor_data must be stored as a JSON
// string (Elementor calls wp_slash on save, which we mimic here so the
// stored copy matches what Elementor itself would write).
$elementor_version = defined('ELEMENTOR_VERSION') ? ELEMENTOR_VERSION : '3.0.0';
update_post_meta($id, '_elementor_edit_mode', 'builder');
update_post_meta($id, '_elementor_template_type', 'wp-page');
update_post_meta($id, '_elementor_version', $elementor_version);
update_post_meta($id, '_elementor_page_settings', array());
update_post_meta($id, '_elementor_data', wp_slash($elementor_data));

// Elementor caches the rendered HTML/CSS in post meta keyed by
// _elementor_css; clear it so our newly-written data is re-rendered.
delete_post_meta($id, '_elementor_css');

update_option('show_on_front', 'page');
update_option('page_on_front', $id);

fwrite(STDOUT, (string) $id);
