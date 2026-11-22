// Region border: turns amber and stops "marching" while the recording is paused.
import { initPage, kadr } from '../../../shared/ui.js';

await initPage();
const apply = (s) => document.body.classList.toggle('paused', s?.status === 'paused');
apply(await kadr.invoke('recorder:get-state'));
kadr.on('recorder:state', apply);
