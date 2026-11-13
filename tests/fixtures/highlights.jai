Gallery :: struct {
    ui: UI.UI_Context;
    theme: UI.UI_Theme;
    materials: MAT.Material_library;
    renderer: R2D.Render2D;
    font_texture: *F.Texture;
    font_view: F.Msdf_Font;
    ready, renderer_ready, started: bool;
    failed: bool;
    frames, checks: int;
    scale: float32 = 1;
    music: bool = true;
    volume: float32 = 0.65;
    name: [..] u8;
    items: []Gallery;
    fixed: [8]Gallery;
    table: Table(8);
    copied := initial_value;
    MAX_COUNT :: 16;
}

inspect :: (gallery: *Gallery) -> F.Texture {
    local_count: int = 0;
    return gallery.font_texture;
}
