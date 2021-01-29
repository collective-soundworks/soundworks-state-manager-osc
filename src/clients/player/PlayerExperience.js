import { AbstractExperience } from '@soundworks/core/client';
import { render, html } from 'lit-html';
import renderInitializationScreens from '@soundworks/template-helpers/client/render-initialization-screens.js';

import '@ircam/simple-components/sc-text.js';
import '@ircam/simple-components/sc-slider.js';
import '@ircam/simple-components/sc-toggle.js';
import '@ircam/simple-components/sc-number.js';
import '@ircam/simple-components/sc-editor.js';

class PlayerExperience extends AbstractExperience {
  constructor(client, config, $container) {
    super(client);

    this.config = config;
    this.$container = $container;
    this.rafId = null;

    // require plugins if needed

    renderInitializationScreens(client, config, $container);
  }

  async start() {
    super.start();

    this.globals = await this.client.stateManager.attach('globals');
    this.globals.subscribe(() => this.render());

    window.addEventListener('resize', () => this.render());
    this.render();
  }

  render() {
    // debounce with requestAnimationFrame
    window.cancelAnimationFrame(this.rafId);

    this.rafId = window.requestAnimationFrame(() => {
      const schema = this.globals.getSchema();

      render(html`
        <div style="padding: 20px">
          <h1 style="margin: 20px 0">${this.client.type} [id: ${this.client.id}]</h1>

          <div>
            <h1>Globals</h1>
            <div style="margin-bottom: 4px">
              <sc-text
                value="volume"
                width="100"
                readonly
              ></sc-text>
              <sc-slider
                display-number
                width="300"
                min="${schema.volume.min}"
                max="${schema.volume.max}"
                step="1"
                value="${this.globals.get('volume')}"
                @input=${e => this.globals.set({ volume: e.detail.value })}
              ></sc-slider>
            </div>
            <div style="margin-bottom: 4px">
              <sc-text
                value="mute"
                width="100"
                readonly
              ></sc-text>
              <sc-toggle
                ?active="${this.globals.get('mute')}"
                @change=${e => this.globals.set({ mute: e.detail.value })}
              ></sc-toggle>
            </div>
            <div style="margin-bottom: 4px">
              <sc-text
                value="gain"
                width="100"
                readonly
              ></sc-text>
              <sc-number
                value="${this.globals.get('gain')}"
                min="${schema.gain.min}"
                max="${schema.gain.max}"
                step="${schema.gain.step}"
                @input=${e => this.globals.set({ gain: e.detail.value })}
              ></sc-number>
            </div>
            <div style="margin-bottom: 4px">
              <sc-text
                value="message"
                width="100"
                readonly
              ></sc-text>
              <sc-text
                value="${this.globals.get('message')}"
                @change=${e => this.globals.set({ message: e.detail.value })}
              ></sc-text>
            </div>
            <div style="margin-bottom: 4px">
              <sc-text
                value="config"
                width="100"
                readonly
              ></sc-text>
              <sc-editor
                value="${JSON.stringify(this.globals.get('config'), null, 2)}"
                @change=${e => this.globals.set({ config: JSON.parse(e.detail.value) })}
              ></sc-editor>
            </div>
        </div>
      `, this.$container);
    });
  }
}

export default PlayerExperience;
