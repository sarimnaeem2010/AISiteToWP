import { randomBytes } from "crypto";

interface CustomPostTypeDef {
  slug: string;
  label: string;
  pluralLabel: string;
  sourceSemanticType: string;
  fields: string[];
  enabled: boolean;
}

export function generateApiKey(): string {
  return randomBytes(32).toString("hex");
}

export function generateWordPressPlugin(
  projectName: string,
  apiKey: string,
  customPostTypes: CustomPostTypeDef[] = [],
): { phpCode: string; filename: string } {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

  const cptsJson = JSON.stringify(
    customPostTypes
      .filter((c) => c.enabled)
      .map((c) => ({
        slug: c.slug.replace(/[^a-z0-9_]/g, "_"),
        label: c.label,
        plural: c.pluralLabel,
      })),
  ).replace(/'/g, "\\'");

  const phpCode = `<?php
/**
 * Plugin Name: WP Bridge AI Importer
 * Plugin URI: https://wpbridgeai.com
 * Description: Receives structured JSON from WP Bridge AI. Imports pages as Gutenberg blocks or Elementor data, registers Custom Post Types, and writes ACF fields.
 * Version: 1.5.0
 * Author: WP Bridge AI
 * License: MIT
 * Text Domain: wp-bridge-ai
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

define( 'WP_BRIDGE_API_KEY', '${apiKey}' );
define( 'WP_BRIDGE_PROJECT_SLUG', '${slug}' );
define( 'WP_BRIDGE_CPTS_JSON', '${cptsJson}' );

/**
 * Register Custom Post Types from the project configuration on init.
 */
add_action( 'init', 'wp_bridge_register_cpts' );
function wp_bridge_register_cpts() {
    $cpts = json_decode( WP_BRIDGE_CPTS_JSON, true );
    if ( ! is_array( $cpts ) ) return;
    foreach ( $cpts as $cpt ) {
        $cpt_slug = isset( $cpt['slug'] ) ? sanitize_key( $cpt['slug'] ) : '';
        if ( ! $cpt_slug ) continue;
        register_post_type( $cpt_slug, array(
            'labels' => array(
                'name'          => $cpt['plural'] ?? $cpt['label'] ?? ucfirst( $cpt_slug ),
                'singular_name' => $cpt['label'] ?? ucfirst( $cpt_slug ),
            ),
            'public'        => true,
            'show_in_rest'  => true,
            'has_archive'   => true,
            'menu_icon'     => 'dashicons-screenoptions',
            'supports'      => array( 'title', 'editor', 'thumbnail', 'custom-fields' ),
            'rewrite'       => array( 'slug' => $cpt_slug ),
        ) );
    }
}

register_activation_hook( __FILE__, 'wp_bridge_on_activate' );
function wp_bridge_on_activate() {
    wp_bridge_register_cpts();
    flush_rewrite_rules();
}
register_deactivation_hook( __FILE__, function() { flush_rewrite_rules(); } );

/**
 * Write template CSS into the active theme's "Additional CSS" via the
 * Customizer post type. Bypasses kses (which strips <style> from page content).
 * Falls back to storing in an option + enqueuing manually if customizer fails.
 */
function wp_bridge_apply_custom_css( $css ) {
    $css = (string) $css;
    // Hard cap to prevent oversized options blowing up the database.
    if ( strlen( $css ) > 1048576 ) { // 1 MB
        $css = substr( $css, 0, 1048576 );
    }
    // Reject obvious HTML/script breakouts. Imported templates are
    // user-supplied content, so neutralize anything that could escape
    // the <style> wrapper or execute JavaScript.
    $css = preg_replace( '/<\\s*\\/\\s*style/i', '<\\/style', $css );
    $css = preg_replace( '/<\\s*script\\b/i', '<-script', $css );
    $css = preg_replace( '/<\\s*\\/\\s*script/i', '<\\/-script', $css );
    // Strip any other raw HTML tags that have no business inside a stylesheet.
    $css = preg_replace( '/<\\s*[a-zA-Z!]/', '<-', $css );
    // Drop javascript: / vbscript: / data: text/html URI schemes from url(...).
    $css = preg_replace( '/url\\(\\s*[\\x22\\x27]?\\s*(javascript|vbscript|data:\\s*text\\/html)/i', 'url(about:blank', $css );
    // expression() in legacy IE CSS could execute JS.
    $css = preg_replace( '/expression\\s*\\(/i', '_expression_(', $css );

    update_option( 'wp_bridge_injected_css', $css, false );

    if ( function_exists( 'wp_update_custom_css_post' ) ) {
        // Wraps in /* Custom CSS */ for the active theme. Returns WP_Error on fail.
        wp_update_custom_css_post( $css );
    }
}

// Always enqueue our stored CSS as a separate stylesheet so the styling
// persists regardless of whether the Customizer write succeeded. Loaded last
// so it overrides theme defaults.
add_action( 'wp_enqueue_scripts', function () {
    $css = get_option( 'wp_bridge_injected_css', '' );
    if ( empty( $css ) ) return;
    wp_register_style( 'wp-bridge-injected', false, array(), '1.4.0' );
    wp_enqueue_style( 'wp-bridge-injected' );
    wp_add_inline_style( 'wp-bridge-injected', $css );
}, 9999 );

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
    register_rest_route( 'ai-cms/v1', '/media', array(
        'methods'             => 'POST',
        'callback'            => 'wp_bridge_media_handler',
        'permission_callback' => 'wp_bridge_auth_check',
    ) );
    register_rest_route( 'ai-cms/v1', '/theme-install', array(
        'methods'             => 'POST',
        'callback'            => 'wp_bridge_theme_install_handler',
        'permission_callback' => 'wp_bridge_auth_check',
    ) );
    register_rest_route( 'ai-cms/v1', '/theme-activate', array(
        'methods'             => 'POST',
        'callback'            => 'wp_bridge_theme_activate_handler',
        'permission_callback' => 'wp_bridge_auth_check',
    ) );
} );

/**
 * Receive a raw .zip body and unpack it as a WordPress theme. The
 * X-Theme-Slug header names the destination directory. Existing dir of
 * the same name is wiped first so re-uploads are idempotent.
 */
function wp_bridge_theme_install_handler( WP_REST_Request $request ) {
    $body = $request->get_body();
    if ( empty( $body ) ) return new WP_Error( 'no_body', 'Empty body', array( 'status' => 400 ) );
    $slug = sanitize_key( $request->get_header( 'X-Theme-Slug' ) ?: '' );
    if ( ! $slug ) return new WP_Error( 'no_slug', 'X-Theme-Slug header required', array( 'status' => 400 ) );

    require_once ABSPATH . 'wp-admin/includes/file.php';
    WP_Filesystem();
    global $wp_filesystem;

    $themes_root = get_theme_root();
    $tmp_zip = wp_tempnam( $slug . '.zip' );
    file_put_contents( $tmp_zip, $body );
    $dest = trailingslashit( $themes_root ) . $slug;
    if ( $wp_filesystem->is_dir( $dest ) ) {
        $wp_filesystem->delete( $dest, true );
    }
    $result = unzip_file( $tmp_zip, $themes_root );
    @unlink( $tmp_zip );
    if ( is_wp_error( $result ) ) {
        return new WP_Error( 'unzip_failed', $result->get_error_message(), array( 'status' => 500 ) );
    }
    // The ZIP root is the theme dir, so we end up with $themes_root/$slug/.
    if ( ! $wp_filesystem->is_dir( $dest ) ) {
        // Some ZIPs include a wrapper dir — find the first child that has a style.css and rename it.
        // Resolve the realpath of the themes root and ensure every candidate stays inside it,
        // otherwise reject (defence-in-depth against ZIP entries with traversal segments).
        $themes_root_real = realpath( $themes_root );
        if ( $themes_root_real === false ) {
            return new WP_Error( 'no_themes_root', 'Cannot resolve themes root', array( 'status' => 500 ) );
        }
        foreach ( scandir( $themes_root ) as $entry ) {
            if ( $entry === '.' || $entry === '..' ) continue;
            $candidate = $themes_root . '/' . $entry;
            $candidate_real = realpath( $candidate );
            if ( $candidate_real === false ) continue;
            if ( strpos( $candidate_real, $themes_root_real . DIRECTORY_SEPARATOR ) !== 0 ) continue;
            if ( is_dir( $candidate ) && file_exists( $candidate . '/style.css' ) && $entry !== $slug ) {
                if ( ! file_exists( $dest ) ) rename( $candidate, $dest );
                break;
            }
        }
    }
    if ( ! file_exists( $dest . '/style.css' ) ) {
        return new WP_Error( 'no_style', 'Theme missing style.css after unzip', array( 'status' => 500 ) );
    }
    return rest_ensure_response( array( 'success' => true, 'slug' => $slug, 'path' => $dest ) );
}

/**
 * Activate a theme by slug. Caller must have installed it first.
 */
function wp_bridge_theme_activate_handler( WP_REST_Request $request ) {
    $params = $request->get_json_params();
    $slug = isset( $params['slug'] ) ? sanitize_key( $params['slug'] ) : '';
    if ( ! $slug ) return new WP_Error( 'no_slug', 'slug required', array( 'status' => 400 ) );
    $theme = wp_get_theme( $slug );
    if ( ! $theme->exists() ) {
        return new WP_Error( 'no_theme', 'Theme not installed', array( 'status' => 404 ) );
    }
    switch_theme( $slug );
    return rest_ensure_response( array( 'success' => true, 'slug' => $slug, 'name' => (string) $theme->get( 'Name' ) ) );
}

/**
 * Accept a raw binary upload from the agent and store it in the WordPress
 * media library. Filename comes from the X-Filename header; mime from
 * Content-Type. Returns the resulting attachment URL.
 */
function wp_bridge_media_handler( WP_REST_Request $request ) {
    $body = $request->get_body();
    if ( empty( $body ) ) {
        return new WP_Error( 'no_body', 'Empty body', array( 'status' => 400 ) );
    }
    $filename = $request->get_header( 'X-Filename' );
    if ( ! $filename ) $filename = 'upload-' . time();
    $filename = sanitize_file_name( $filename );

    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';

    $upload = wp_upload_bits( $filename, null, $body );
    if ( ! empty( $upload['error'] ) ) {
        return new WP_Error( 'upload_failed', $upload['error'], array( 'status' => 500 ) );
    }
    $filetype = wp_check_filetype( $upload['file'], null );
    $attachment = array(
        'post_mime_type' => $filetype['type'] ?? $request->get_content_type()['value'] ?? 'application/octet-stream',
        'post_title'     => sanitize_text_field( pathinfo( $filename, PATHINFO_FILENAME ) ),
        'post_content'   => '',
        'post_status'    => 'inherit',
    );
    $attach_id = wp_insert_attachment( $attachment, $upload['file'] );
    if ( is_wp_error( $attach_id ) ) {
        return new WP_Error( 'attach_failed', $attach_id->get_error_message(), array( 'status' => 500 ) );
    }
    $attach_data = wp_generate_attachment_metadata( $attach_id, $upload['file'] );
    wp_update_attachment_metadata( $attach_id, $attach_data );

    return rest_ensure_response( array(
        'id'  => $attach_id,
        'url' => wp_get_attachment_url( $attach_id ),
    ) );
}

function wp_bridge_auth_check( WP_REST_Request $request ) {
    $key = $request->get_header( 'X-Api-Key' );
    if ( $key !== WP_BRIDGE_API_KEY ) {
        return new WP_Error( 'forbidden', 'Invalid API key', array( 'status' => 403 ) );
    }
    return true;
}

function wp_bridge_status_handler( WP_REST_Request $request ) {
    return rest_ensure_response( array(
        'active'             => true,
        'version'            => '1.4.0',
        'project'            => WP_BRIDGE_PROJECT_SLUG,
        'wp_version'         => get_bloginfo( 'version' ),
        'site_name'          => get_bloginfo( 'name' ),
        'acf_active'         => function_exists( 'get_field' ),
        'elementor_active'   => did_action( 'elementor/loaded' ) > 0 || class_exists( '\\\\Elementor\\\\Plugin' ),
        'registered_cpts'    => json_decode( WP_BRIDGE_CPTS_JSON, true ),
    ) );
}

/**
 * Main import handler.
 * Body: {
 *   renderer?: "gutenberg" | "elementor",
 *   pages: [{ title, slug, blocks: [...], elementorData?: [...] }],
 *   cptItems?: [{ cptSlug, title, fields }]
 * }
 */
function wp_bridge_import_handler( WP_REST_Request $request ) {
    $body = $request->get_json_params();

    if ( empty( $body['pages'] ) || ! is_array( $body['pages'] ) ) {
        return new WP_Error( 'invalid_data', 'Missing pages array', array( 'status' => 400 ) );
    }

    $renderer = isset( $body['renderer'] ) && $body['renderer'] === 'elementor' ? 'elementor' : 'gutenberg';
    $results = array();
    $cpt_results = array();

    // Inject the original template's CSS site-wide via the Customizer's
    // Additional CSS. This bypasses kses sanitization (which strips <style>
    // from page content for users without unfiltered_html, e.g. Hostinger).
    if ( ! empty( $body['injectedCss'] ) && is_string( $body['injectedCss'] ) ) {
        wp_bridge_apply_custom_css( $body['injectedCss'] );
    }

    foreach ( $body['pages'] as $page_data ) {
        $title  = sanitize_text_field( $page_data['title'] ?? 'Imported Page' );
        $slug   = sanitize_title( $page_data['slug'] ?? $title );
        $blocks = $page_data['blocks'] ?? array();
        $elementor_data = $page_data['elementorData'] ?? null;

        if ( $renderer === 'elementor' && is_array( $elementor_data ) ) {
            $content = '';
        } elseif ( ! empty( $page_data['prebuiltContent'] ) && is_string( $page_data['prebuiltContent'] ) ) {
            // Pixel-perfect mode: composer already built the block markup
            // referencing our theme's custom blocks.
            $content = $page_data['prebuiltContent'];
        } else {
            $content = wp_bridge_build_block_content( $blocks );
        }

        $existing = get_page_by_path( $slug, OBJECT, 'page' );

        if ( $existing ) {
            $page_id = wp_update_post( array(
                'ID'           => $existing->ID,
                'post_title'   => $title,
                'post_content' => $content,
                'post_status'  => 'publish',
                'post_name'    => $slug,
            ) );
            $action = 'updated';
        } else {
            $page_id = wp_insert_post( array(
                'post_title'   => $title,
                'post_content' => $content,
                'post_status'  => 'publish',
                'post_type'    => 'page',
                'post_name'    => $slug,
            ) );
            $action = 'created';
        }

        if ( is_wp_error( $page_id ) ) {
            $results[] = array(
                'page'   => $title,
                'status' => 'error',
                'error'  => $page_id->get_error_message(),
            );
            continue;
        }

        if ( $renderer === 'elementor' && is_array( $elementor_data ) ) {
            update_post_meta( $page_id, '_elementor_edit_mode', 'builder' );
            update_post_meta( $page_id, '_elementor_template_type', 'wp-page' );
            update_post_meta( $page_id, '_elementor_version', '3.18.0' );
            update_post_meta( $page_id, '_elementor_data', wp_slash( wp_json_encode( $elementor_data ) ) );
            update_post_meta( $page_id, '_elementor_page_settings', array() );
        }

        if ( function_exists( 'update_field' ) ) {
            wp_bridge_update_acf_fields( $page_id, $blocks );
        }

        update_post_meta( $page_id, '_wp_bridge_blocks', wp_json_encode( $blocks ) );
        update_post_meta( $page_id, '_wp_bridge_renderer', $renderer );
        update_post_meta( $page_id, '_wp_bridge_imported_at', current_time( 'mysql' ) );
        update_post_meta( $page_id, '_wp_bridge_project', WP_BRIDGE_PROJECT_SLUG );

        $results[] = array(
            'page'   => $title,
            'id'     => $page_id,
            'url'    => get_permalink( $page_id ),
            'status' => $action,
        );
    }

    // Import CPT items
    if ( ! empty( $body['cptItems'] ) && is_array( $body['cptItems'] ) ) {
        foreach ( $body['cptItems'] as $item ) {
            $cpt_slug = isset( $item['cptSlug'] ) ? sanitize_key( $item['cptSlug'] ) : '';
            $title    = sanitize_text_field( $item['title'] ?? 'Item' );
            $fields   = $item['fields'] ?? array();
            if ( ! $cpt_slug || ! post_type_exists( $cpt_slug ) ) {
                $cpt_results[] = array( 'cpt' => $cpt_slug, 'title' => $title, 'status' => 'error', 'error' => 'CPT not registered' );
                continue;
            }
            $existing_id = wp_bridge_find_cpt_by_title( $cpt_slug, $title );
            $args = array(
                'post_title'   => $title,
                'post_content' => isset( $fields['description'] ) ? $fields['description'] : ( isset( $fields['quote'] ) ? $fields['quote'] : '' ),
                'post_status'  => 'publish',
                'post_type'    => $cpt_slug,
            );
            if ( $existing_id ) {
                $args['ID'] = $existing_id;
                $post_id = wp_update_post( $args );
                $cpt_action = 'updated';
            } else {
                $post_id = wp_insert_post( $args );
                $cpt_action = 'created';
            }
            if ( is_wp_error( $post_id ) ) {
                $cpt_results[] = array( 'cpt' => $cpt_slug, 'title' => $title, 'status' => 'error', 'error' => $post_id->get_error_message() );
                continue;
            }
            foreach ( $fields as $fk => $fv ) {
                update_post_meta( $post_id, sanitize_key( $fk ), is_scalar( $fv ) ? $fv : wp_json_encode( $fv ) );
                if ( function_exists( 'update_field' ) ) {
                    update_field( sanitize_key( $fk ), $fv, $post_id );
                }
            }
            update_post_meta( $post_id, '_wp_bridge_project', WP_BRIDGE_PROJECT_SLUG );
            $cpt_results[] = array( 'cpt' => $cpt_slug, 'title' => $title, 'id' => $post_id, 'status' => $cpt_action );
        }
    }

    return rest_ensure_response( array(
        'success'     => true,
        'results'     => $results,
        'cpt_results' => $cpt_results,
        'renderer'    => $renderer,
    ) );
}

function wp_bridge_find_cpt_by_title( string $cpt, string $title ) {
    $q = new WP_Query( array(
        'post_type'      => $cpt,
        'title'          => $title,
        'posts_per_page' => 1,
        'fields'         => 'ids',
        'no_found_rows'  => true,
    ) );
    return $q->have_posts() ? (int) $q->posts[0] : 0;
}

function wp_bridge_build_block_content( array $blocks ): string {
    $content = '';
    foreach ( $blocks as $block ) {
        $type      = $block['blockType'] ?? 'core/html';
        $acf_group = $block['acfGroup'] ?? '';
        $fields    = $block['fields'] ?? array();
        $inner     = $block['innerBlocks'] ?? array();

        switch ( $type ) {
            case 'core/cover':
                $headline    = esc_html( $fields['headline'] ?? '' );
                $subheadline = esc_html( $fields['subheadline'] ?? '' );
                $cta_text    = esc_html( $fields['cta_text'] ?? '' );
                $cta_url     = esc_url( $fields['cta_url'] ?? '#' );
                $bg_image    = esc_url( $fields['background_image'] ?? '' );
                // Skip emitting an empty cover (would otherwise fall back to theme placeholder pattern)
                if ( ! $headline && ! $subheadline && ! $cta_text && ! $bg_image ) {
                    break;
                }
                if ( $bg_image ) {
                    $content .= "<!-- wp:cover {\\"url\\":\\"{$bg_image}\\",\\"dimRatio\\":50} -->\\n";
                    $content .= "<div class=\\"wp-block-cover\\"><img class=\\"wp-block-cover__image-background\\" src=\\"{$bg_image}\\" alt=\\"\\"/><span aria-hidden=\\"true\\" class=\\"wp-block-cover__background has-background-dim\\"></span><div class=\\"wp-block-cover__inner-container\\">";
                } else {
                    // No background image: render as plain group instead of cover so the theme
                    // doesn't fill an empty cover with its default pattern image.
                    $content .= "<!-- wp:group {\\"layout\\":{\\"type\\":\\"constrained\\"}} -->\\n<div class=\\"wp-block-group\\">";
                }
                if ( $headline ) $content .= "<!-- wp:heading --><h2 class=\\"wp-block-heading\\">{$headline}</h2><!-- /wp:heading -->";
                if ( $subheadline ) $content .= "<!-- wp:paragraph --><p>{$subheadline}</p><!-- /wp:paragraph -->";
                if ( $cta_text ) $content .= "<!-- wp:buttons --><div class=\\"wp-block-buttons\\"><!-- wp:button --><div class=\\"wp-block-button\\"><a class=\\"wp-block-button__link\\" href=\\"{$cta_url}\\">{$cta_text}</a></div><!-- /wp:button --></div><!-- /wp:buttons -->";
                if ( $bg_image ) {
                    $content .= "</div></div><!-- /wp:cover -->\\n";
                } else {
                    $content .= "</div><!-- /wp:group -->\\n";
                }
                break;

            case 'core/html':
                $html_content = $fields['content'] ?? '';
                if ( $html_content ) {
                    $content .= "<!-- wp:html -->\\n{$html_content}\\n<!-- /wp:html -->\\n";
                }
                break;

            case 'core/gallery':
                $gallery_title = esc_html( $fields['section_title'] ?? '' );
                $imgs = $fields['logos'] ?? $fields['images'] ?? $fields['items'] ?? array();
                $content .= "<!-- wp:group {\\"layout\\":{\\"type\\":\\"constrained\\"}} -->\\n<div class=\\"wp-block-group\\">";
                if ( $gallery_title ) $content .= "<!-- wp:heading --><h2 class=\\"wp-block-heading\\">{$gallery_title}</h2><!-- /wp:heading -->";
                if ( is_array( $imgs ) && count( $imgs ) > 0 ) {
                    $content .= "<!-- wp:gallery {\\"linkTo\\":\\"none\\"} --><figure class=\\"wp-block-gallery has-nested-images columns-default is-cropped\\">";
                    foreach ( $imgs as $img ) {
                        if ( is_string( $img ) ) {
                            $src = esc_url( $img );
                            $alt = '';
                        } else {
                            $src = esc_url( $img['src'] ?? $img['url'] ?? $img['image_url'] ?? $img['logo_url'] ?? '' );
                            $alt = esc_attr( $img['alt'] ?? $img['name'] ?? $img['title'] ?? '' );
                        }
                        if ( $src ) $content .= "<!-- wp:image --><figure class=\\"wp-block-image\\"><img src=\\"{$src}\\" alt=\\"{$alt}\\"/></figure><!-- /wp:image -->";
                    }
                    $content .= "</figure><!-- /wp:gallery -->";
                }
                $content .= "</div><!-- /wp:group -->\\n";
                break;

            default:
                $title = esc_html( $fields['section_title'] ?? $fields['heading'] ?? '' );
                $body  = esc_html( $fields['section_body'] ?? $fields['body'] ?? $fields['description'] ?? $fields['subheading'] ?? '' );
                $content .= "<!-- wp:group {\\"layout\\":{\\"type\\":\\"constrained\\"}} -->\\n<div class=\\"wp-block-group\\">";
                if ( $title ) $content .= "<!-- wp:heading --><h2 class=\\"wp-block-heading\\">{$title}</h2><!-- /wp:heading -->";
                if ( $body ) $content .= "<!-- wp:paragraph --><p>{$body}</p><!-- /wp:paragraph -->";

                // Stats section: render value + label tiles
                if ( $acf_group === 'stats_section' && is_array( $inner ) && count( $inner ) > 0 ) {
                    $content .= "<!-- wp:columns --><div class=\\"wp-block-columns\\">";
                    foreach ( $inner as $stat ) {
                        $sf    = $stat['fields'] ?? array();
                        $value = esc_html( $sf['value'] ?? '' );
                        $label = esc_html( $sf['label'] ?? '' );
                        if ( $value || $label ) {
                            $content .= "<!-- wp:column --><div class=\\"wp-block-column\\">";
                            if ( $value ) $content .= "<!-- wp:heading {\\"level\\":3} --><h3 class=\\"wp-block-heading\\">{$value}</h3><!-- /wp:heading -->";
                            if ( $label ) $content .= "<!-- wp:paragraph --><p>{$label}</p><!-- /wp:paragraph -->";
                            $content .= "</div><!-- /wp:column -->";
                        }
                    }
                    $content .= "</div><!-- /wp:columns -->";
                }

                // Newsletter / CTA section: render subscribe button
                if ( $acf_group === 'newsletter_section' || $acf_group === 'cta_section' ) {
                    $btn_text = esc_html( $fields['button_text'] ?? $fields['cta_text'] ?? '' );
                    $btn_url  = esc_url( $fields['button_url'] ?? $fields['cta_url'] ?? '#' );
                    if ( $btn_text ) {
                        $content .= "<!-- wp:buttons --><div class=\\"wp-block-buttons\\"><!-- wp:button --><div class=\\"wp-block-button\\"><a class=\\"wp-block-button__link\\" href=\\"{$btn_url}\\">{$btn_text}</a></div><!-- /wp:button --></div><!-- /wp:buttons -->";
                    }
                }

                // Footer section: render copyright + links
                if ( $acf_group === 'footer_section' ) {
                    $copy = esc_html( $fields['copyright_text'] ?? '' );
                    $links = $fields['links'] ?? array();
                    if ( is_array( $links ) && count( $links ) > 0 ) {
                        $content .= "<!-- wp:list --><ul class=\\"wp-block-list\\">";
                        foreach ( $links as $link ) {
                            if ( is_string( $link ) ) {
                                $content .= "<!-- wp:list-item --><li>" . esc_html( $link ) . "</li><!-- /wp:list-item -->";
                            } else {
                                $href = esc_url( $link['url'] ?? $link['href'] ?? '#' );
                                $lbl  = esc_html( $link['label'] ?? $link['text'] ?? $link['title'] ?? '' );
                                if ( $lbl ) $content .= "<!-- wp:list-item --><li><a href=\\"{$href}\\">{$lbl}</a></li><!-- /wp:list-item -->";
                            }
                        }
                        $content .= "</ul><!-- /wp:list -->";
                    }
                    if ( $copy ) $content .= "<!-- wp:paragraph {\\"align\\":\\"center\\"} --><p class=\\"has-text-align-center\\">{$copy}</p><!-- /wp:paragraph -->";
                }

                // Generic inner-block fallback (features, services, team, faq, testimonials, pricing)
                foreach ( $inner as $inner_block ) {
                    $inner_fields = $inner_block['fields'] ?? array();
                    $inner_title  = esc_html( $inner_fields['title'] ?? $inner_fields['question'] ?? $inner_fields['name'] ?? $inner_fields['plan_name'] ?? '' );
                    $inner_body   = esc_html( $inner_fields['description'] ?? $inner_fields['answer'] ?? $inner_fields['quote'] ?? $inner_fields['bio'] ?? '' );
                    $inner_price  = esc_html( $inner_fields['plan_price'] ?? $inner_fields['price'] ?? '' );
                    $inner_role   = esc_html( $inner_fields['role'] ?? $inner_fields['author_role'] ?? '' );
                    if ( $inner_title || $inner_body || $inner_price ) {
                        $content .= "<!-- wp:group --><div class=\\"wp-block-group\\">";
                        if ( $inner_title ) $content .= "<!-- wp:heading {\\"level\\":3} --><h3>{$inner_title}</h3><!-- /wp:heading -->";
                        if ( $inner_price ) $content .= "<!-- wp:paragraph --><p><strong>{$inner_price}</strong></p><!-- /wp:paragraph -->";
                        if ( $inner_role )  $content .= "<!-- wp:paragraph --><p><em>{$inner_role}</em></p><!-- /wp:paragraph -->";
                        if ( $inner_body )  $content .= "<!-- wp:paragraph --><p>{$inner_body}</p><!-- /wp:paragraph -->";
                        $content .= "</div><!-- /wp:group -->";
                    }
                }
                $content .= "</div><!-- /wp:group -->\\n";
                break;
        }
    }
    return $content;
}

function wp_bridge_update_acf_fields( int $post_id, array $blocks ): void {
    foreach ( $blocks as $block ) {
        $acf_group = $block['acfGroup'] ?? null;
        $fields    = $block['fields'] ?? array();
        if ( ! $acf_group || ! $fields ) continue;
        foreach ( $fields as $field_key => $field_value ) {
            $full_key = $acf_group . '_' . $field_key;
            update_field( $full_key, $field_value, $post_id );
        }
        $inner_blocks = $block['innerBlocks'] ?? array();
        if ( ! empty( $inner_blocks ) && $acf_group ) {
            $repeater_data = array();
            foreach ( $inner_blocks as $inner ) {
                $repeater_data[] = $inner['fields'] ?? array();
            }
            update_field( $acf_group . '_items', $repeater_data, $post_id );
        }
    }
}
`;

  return {
    phpCode,
    filename: `wp-bridge-ai-importer.php`,
  };
}
