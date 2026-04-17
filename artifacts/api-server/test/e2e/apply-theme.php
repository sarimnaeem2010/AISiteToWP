#!/usr/bin/env php
<?php
/**
 * Bootstraps WP, activates the supplied theme slug, and creates (or
 * updates) a page whose post_content is read from stdin. Prints the new
 * page id on stdout.
 *
 * usage: apply-theme.php <wp-dir> <theme-slug> <page-slug> <page-title>
 */
$wp_dir     = $argv[1] ?? null;
$theme_slug = $argv[2] ?? null;
$page_slug  = $argv[3] ?? null;
$page_title = $argv[4] ?? 'Home';

if (!$wp_dir || !$theme_slug || !$page_slug) {
    fwrite(STDERR, "usage: apply-theme.php <wp-dir> <theme-slug> <page-slug> <page-title>\n");
    exit(1);
}

$_SERVER['HTTP_HOST']   = 'localhost';
$_SERVER['REQUEST_URI'] = '/';
require_once $wp_dir . '/wp-load.php';

$content = stream_get_contents(STDIN);

switch_theme($theme_slug);
$active = wp_get_theme()->get_stylesheet();
if ($active !== $theme_slug) {
    fwrite(STDERR, "[apply-theme] failed to activate theme; active=$active\n");
    exit(2);
}

// Pretty permalinks so /home resolves correctly.
update_option('permalink_structure', '/%postname%/');
flush_rewrite_rules(false);

$existing = get_page_by_path($page_slug);
$post_arr = array(
    'post_title'   => $page_title,
    'post_name'    => $page_slug,
    'post_status'  => 'publish',
    'post_type'    => 'page',
    'post_content' => $content,
);
if ($existing) {
    $post_arr['ID'] = $existing->ID;
    $id = wp_update_post($post_arr, true);
} else {
    $id = wp_insert_post($post_arr, true);
}
if (is_wp_error($id)) {
    fwrite(STDERR, "[apply-theme] insert/update failed: " . $id->get_error_message() . "\n");
    exit(3);
}

// Set as the front page so / serves it.
update_option('show_on_front', 'page');
update_option('page_on_front', $id);

fwrite(STDOUT, (string) $id);
