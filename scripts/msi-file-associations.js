'use strict';

const fs = require('node:fs/promises');
const { build } = require('../package.json');

module.exports = async function addFileAssociations(projectFile) {
  // The MSI owns these per-user registry values and removes them on uninstall.
  // OpenWithProgids makes Kadr available without setting a default application.
  const executable = '&quot;[#mainExecutable]&quot;';
  const command = `${executable} &quot;%1&quot;`;
  const value = (key, content, name = '', keyPath = false) =>
    `<RegistryValue Root="HKCU" Key="Software\\Classes\\${key}" Type="string" Value="${content}"${name ? ` Name="${name}"` : ''}${keyPath ? ' KeyPath="yes"' : ''}/>`;
  const app = 'Applications\\Kadr.exe';
  const entries = [
    value(app, 'Kadr', 'FriendlyAppName', true),
    value(`${app}\\shell\\open\\command`, command),
  ];
  for (const { ext, name } of build.mac.fileAssociations) {
    const progId = `Kadr.${name}`;
    const menu = `SystemFileAssociations\\${name.toLowerCase()}\\shell\\KadrEdit`;
    entries.push(
      value(progId, `Kadr ${name}`),
      value(`${progId}\\DefaultIcon`, `${executable},0`),
      value(`${progId}\\shell\\open`, 'Kadr', 'FriendlyAppName'),
      value(`${progId}\\shell\\open\\command`, command),
      value(menu, 'Редактировать в Kadr'),
      value(menu, executable, 'Icon'),
      value(`${menu}\\command`, command),
    );
    for (const extension of ext) {
      entries.push(
        value(`.${extension}\\OpenWithProgids`, '', progId),
        value(`${app}\\SupportedTypes`, '', `.${extension}`),
      );
    }
  }

  const project = await fs.readFile(projectFile, 'utf8');
  const group = '<ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER">';
  if (!project.includes(group)) throw new Error('Cannot add Kadr file associations to the WiX project.');
  const component = `<Component Id="KadrFileAssociations" Guid="*">\n${entries.join('\n')}\n</Component>`;
  await fs.writeFile(projectFile, project.replace(group, `${group}\n${component}`));
};
