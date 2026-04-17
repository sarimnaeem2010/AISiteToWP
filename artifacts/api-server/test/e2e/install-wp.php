#!/usr/bin/env php
<?php
/**
 * Programmatic WordPress installer for the end-to-end test sandbox.
 * Invoked by setup-wp.sh once the wp-config.php + SQLite drop-in are
 * in place. Idempotent: bails if WP is already installed.
 */
$wp_dir = $argv[1] ?? null;
if (!$wp_dir || !is_dir($wp_dir)) {
    fwrite(STDERR, "usage: install-wp.php <wp-dir>\n");
    exit(1);
}

define('WP_INSTALLING', true);
$_SERVER['HTTP_HOST']   = 'localhost';
$_SERVER['REQUEST_URI'] = '/';
require_once $wp_dir . '/wp-load.php';
require_once $wp_dir . '/wp-admin/includes/upgrade.php';

if (is_blog_installed()) {
    fwrite(STDOUT, "[install-wp] already installed\n");
    exit(0);
}

$result = wp_install(
    'WPB E2E',
    'admin',
    'admin@example.com',
    true,                  // public
    '',
    'admin-password',
    'en_US'
);

fwrite(STDOUT, "[install-wp] installed admin user_id=" . $result['user_id'] . "\n");
