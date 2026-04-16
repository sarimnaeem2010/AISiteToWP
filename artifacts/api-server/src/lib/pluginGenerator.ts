import { randomBytes } from "crypto";

export function generateApiKey(): string {
  return randomBytes(32).toString("hex");
}

export function generateWordPressPlugin(projectName: string, apiKey: string): { phpCode: string; filename: string } {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

  const phpCode = `<?php
/**
 * Plugin Name: WP Bridge AI Importer
 * Plugin URI: https://wpbridgeai.com
 * Description: Receives structured JSON from WP Bridge AI and converts it to WordPress pages with Gutenberg blocks and ACF fields.
 * Version: 1.0.0
 * Author: WP Bridge AI
 * License: MIT
 * Text Domain: wp-bridge-ai
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

// API Key — generated per project
define( 'WP_BRIDGE_API_KEY', '${apiKey}' );
define( 'WP_BRIDGE_PROJECT_SLUG', '${slug}' );

/**
 * Register the REST API endpoint
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'ai-cms/v1', '/import', array(
        'methods'             => 'POST',
        'callback'            => 'wp_bridge_import_handler',
        'permission_callback' => 'wp_bridge_auth_check',
    ) );
    register_rest_route( 'ai-cms/v1', '/status', array(
        'methods'             => 'GET',
        'callback'            => 'wp_bridge_status_handler',
        'permission_callback' => 'wp_bridge_auth_check',
    ) );
} );

/**
 * Authenticate requests using API key in X-Api-Key header
 */
function wp_bridge_auth_check( WP_REST_Request \\$request ) {
    \\$key = \\$request->get_header( 'X-Api-Key' );
    if ( \\$key !== WP_BRIDGE_API_KEY ) {
        return new WP_Error( 'forbidden', 'Invalid API key', array( 'status' => 403 ) );
    }
    return true;
}

/**
 * Status endpoint — confirms plugin is active
 */
function wp_bridge_status_handler( WP_REST_Request \\$request ) {
    return rest_ensure_response( array(
        'active'       => true,
        'version'      => '1.0.0',
        'project'      => WP_BRIDGE_PROJECT_SLUG,
        'wp_version'   => get_bloginfo( 'version' ),
        'site_name'    => get_bloginfo( 'name' ),
        'acf_active'   => function_exists( 'get_field' ),
    ) );
}

/**
 * Main import handler
 * Accepts: { pages: [{ title, slug, blocks: [{ blockType, acfGroup, fields }] }] }
 */
function wp_bridge_import_handler( WP_REST_Request \\$request ) {
    \\$body = \\$request->get_json_params();

    if ( empty( \\$body['pages'] ) || ! is_array( \\$body['pages'] ) ) {
        return new WP_Error( 'invalid_data', 'Missing pages array', array( 'status' => 400 ) );
    }

    \\$results = array();

    foreach ( \\$body['pages'] as \\$page_data ) {
        \\$title  = sanitize_text_field( \\$page_data['title'] ?? 'Imported Page' );
        \\$slug   = sanitize_title( \\$page_data['slug'] ?? \\$title );
        \\$blocks = \\$page_data['blocks'] ?? array();

        // Build Gutenberg block content
        \\$content = wp_bridge_build_block_content( \\$blocks );

        // Check if page exists
        \\$existing = get_page_by_path( \\$slug, OBJECT, 'page' );

        if ( \\$existing ) {
            \\$page_id = wp_update_post( array(
                'ID'           => \\$existing->ID,
                'post_title'   => \\$title,
                'post_content' => \\$content,
                'post_status'  => 'publish',
                'post_name'    => \\$slug,
            ) );
            \\$action = 'updated';
        } else {
            \\$page_id = wp_insert_post( array(
                'post_title'   => \\$title,
                'post_content' => \\$content,
                'post_status'  => 'publish',
                'post_type'    => 'page',
                'post_name'    => \\$slug,
            ) );
            \\$action = 'created';
        }

        if ( is_wp_error( \\$page_id ) ) {
            \\$results[] = array(
                'page'   => \\$title,
                'status' => 'error',
                'error'  => \\$page_id->get_error_message(),
            );
            continue;
        }

        // Store ACF fields if ACF is active
        if ( function_exists( 'update_field' ) ) {
            wp_bridge_update_acf_fields( \\$page_id, \\$blocks );
        }

        // Store raw mapping metadata
        update_post_meta( \\$page_id, '_wp_bridge_blocks', wp_json_encode( \\$blocks ) );
        update_post_meta( \\$page_id, '_wp_bridge_imported_at', current_time( 'mysql' ) );
        update_post_meta( \\$page_id, '_wp_bridge_project', WP_BRIDGE_PROJECT_SLUG );

        \\$results[] = array(
            'page'   => \\$title,
            'id'     => \\$page_id,
            'url'    => get_permalink( \\$page_id ),
            'status' => \\$action,
        );
    }

    return rest_ensure_response( array(
        'success' => true,
        'results' => \\$results,
    ) );
}

/**
 * Build Gutenberg block HTML from block definitions
 */
function wp_bridge_build_block_content( array \\$blocks ): string {
    \\$content = '';

    foreach ( \\$blocks as \\$block ) {
        \\$type   = \\$block['blockType'] ?? 'core/html';
        \\$fields = \\$block['fields'] ?? array();
        \\$inner  = \\$block['innerBlocks'] ?? array();

        switch ( \\$type ) {
            case 'core/cover':
                \\$headline    = esc_html( \\$fields['headline'] ?? '' );
                \\$subheadline = esc_html( \\$fields['subheadline'] ?? '' );
                \\$cta_text    = esc_html( \\$fields['cta_text'] ?? '' );
                \\$cta_url     = esc_url( \\$fields['cta_url'] ?? '#' );
                \\$content .= "<!-- wp:cover {\\\"dimRatio\\\":50} -->\\n";
                \\$content .= "<div class=\\"wp-block-cover\\"><div class=\\"wp-block-cover__inner-container\\">";
                if ( \\$headline ) \\$content .= "<!-- wp:heading --><h2 class=\\"wp-block-heading\\">{\\$headline}</h2><!-- /wp:heading -->";
                if ( \\$subheadline ) \\$content .= "<!-- wp:paragraph --><p>{\\$subheadline}</p><!-- /wp:paragraph -->";
                if ( \\$cta_text ) \\$content .= "<!-- wp:buttons --><div class=\\"wp-block-buttons\\"><!-- wp:button --><div class=\\"wp-block-button\\"><a class=\\"wp-block-button__link\\" href=\\"{\\$cta_url}\\">{\\$cta_text}</a></div><!-- /wp:button --></div><!-- /wp:buttons -->";
                \\$content .= "</div></div><!-- /wp:cover -->\\n";
                break;

            case 'core/html':
                \\$html_content = \\$fields['content'] ?? '';
                if ( \\$html_content ) {
                    \\$content .= "<!-- wp:html -->\\n{\\$html_content}\\n<!-- /wp:html -->\\n";
                }
                break;

            default:
                \\$title = esc_html( \\$fields['section_title'] ?? \\$fields['heading'] ?? '' );
                \\$body  = esc_html( \\$fields['section_body'] ?? \\$fields['body'] ?? \\$fields['description'] ?? '' );
                \\$content .= "<!-- wp:group {\\\"layout\\\":{\\\"type\\\":\\\"constrained\\\"}} -->\\n<div class=\\"wp-block-group\\">";
                if ( \\$title ) \\$content .= "<!-- wp:heading --><h2 class=\\"wp-block-heading\\">{\\$title}</h2><!-- /wp:heading -->";
                if ( \\$body ) \\$content .= "<!-- wp:paragraph --><p>{\\$body}</p><!-- /wp:paragraph -->";

                foreach ( \\$inner as \\$inner_block ) {
                    \\$inner_fields = \\$inner_block['fields'] ?? array();
                    \\$inner_title  = esc_html( \\$inner_fields['title'] ?? \\$inner_fields['question'] ?? '' );
                    \\$inner_body   = esc_html( \\$inner_fields['description'] ?? \\$inner_fields['answer'] ?? \\$inner_fields['quote'] ?? '' );
                    if ( \\$inner_title || \\$inner_body ) {
                        \\$content .= "<!-- wp:group --><div class=\\"wp-block-group\\">";
                        if ( \\$inner_title ) \\$content .= "<!-- wp:heading {\\\"level\\\":3} --><h3>{\\$inner_title}</h3><!-- /wp:heading -->";
                        if ( \\$inner_body ) \\$content .= "<!-- wp:paragraph --><p>{\\$inner_body}</p><!-- /wp:paragraph -->";
                        \\$content .= "</div><!-- /wp:group -->";
                    }
                }

                \\$content .= "</div><!-- /wp:group -->\\n";
                break;
        }
    }

    return \\$content;
}

/**
 * Update ACF fields from block definitions
 */
function wp_bridge_update_acf_fields( int \\$post_id, array \\$blocks ): void {
    foreach ( \\$blocks as \\$block ) {
        \\$acf_group = \\$block['acfGroup'] ?? null;
        \\$fields    = \\$block['fields'] ?? array();
        if ( ! \\$acf_group || ! \\$fields ) continue;

        foreach ( \\$fields as \\$field_key => \\$field_value ) {
            \\$full_key = \\$acf_group . '_' . \\$field_key;
            update_field( \\$full_key, \\$field_value, \\$post_id );
        }

        // Handle repeater sub-fields
        \\$inner_blocks = \\$block['innerBlocks'] ?? array();
        if ( ! empty( \\$inner_blocks ) && \\$acf_group ) {
            \\$repeater_data = array();
            foreach ( \\$inner_blocks as \\$inner ) {
                \\$repeater_data[] = \\$inner['fields'] ?? array();
            }
            update_field( \\$acf_group . '_items', \\$repeater_data, \\$post_id );
        }
    }
}
`;

  return {
    phpCode,
    filename: `wp-bridge-ai-importer.php`,
  };
}
