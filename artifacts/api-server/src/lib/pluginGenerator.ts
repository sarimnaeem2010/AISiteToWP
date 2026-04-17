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
 * Version: 1.3.0
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
        'version'            => '1.3.0',
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

    foreach ( $body['pages'] as $page_data ) {
        $title  = sanitize_text_field( $page_data['title'] ?? 'Imported Page' );
        $slug   = sanitize_title( $page_data['slug'] ?? $title );
        $blocks = $page_data['blocks'] ?? array();
        $elementor_data = $page_data['elementorData'] ?? null;

        if ( $renderer === 'elementor' && is_array( $elementor_data ) ) {
            $content = '';
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
                $content .= "<!-- wp:cover {\\"dimRatio\\":50} -->\\n";
                $content .= "<div class=\\"wp-block-cover\\"><div class=\\"wp-block-cover__inner-container\\">";
                if ( $headline ) $content .= "<!-- wp:heading --><h2 class=\\"wp-block-heading\\">{$headline}</h2><!-- /wp:heading -->";
                if ( $subheadline ) $content .= "<!-- wp:paragraph --><p>{$subheadline}</p><!-- /wp:paragraph -->";
                if ( $cta_text ) $content .= "<!-- wp:buttons --><div class=\\"wp-block-buttons\\"><!-- wp:button --><div class=\\"wp-block-button\\"><a class=\\"wp-block-button__link\\" href=\\"{$cta_url}\\">{$cta_text}</a></div><!-- /wp:button --></div><!-- /wp:buttons -->";
                $content .= "</div></div><!-- /wp:cover -->\\n";
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
