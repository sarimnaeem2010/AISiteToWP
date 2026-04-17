#!/usr/bin/env php
<?php
/**
 * php -S router for WordPress: serves static files directly, otherwise
 * routes everything through index.php so pretty permalinks resolve.
 *
 * Note: php -S sets $_SERVER['DOCUMENT_ROOT'] to the -t target. Resolve
 * everything relative to that, NOT __DIR__ (which is wherever this
 * router file happens to live on disk).
 */
$root = rtrim($_SERVER['DOCUMENT_ROOT'], '/');
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = $root . $path;
if ($path !== '/' && file_exists($file) && !is_dir($file)) {
    return false;
}
$_SERVER['SCRIPT_NAME']     = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
chdir($root);
require $root . '/index.php';
